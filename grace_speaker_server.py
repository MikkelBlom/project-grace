#!/usr/bin/env python3
"""
grace_speaker_server.py — speaker-verification gate so Grace only acts on Mikkel's voice.

Runs a small WeSpeaker/ECAPA-class speaker-embedding model via sherpa-onnx on the CPU (Apache-2.0,
fully offline, ~27 MB ONNX). It stays OFF the RTX (reserved for the 26B LLM) and OFF the Arc iGPU
(reserved for Whisper STT) — the model is tiny enough that CPU inference is single-digit-ms per
utterance. See docs/11-REMAINING-DESIGN.md and the audio research notes.

Contract (same http.server style as grace_embed_server.py):
    POST /enroll  {"samples": [float @16k], "sample_rate": 16000}  -> {"enrolled": N, "ok": true}
                  (call a few times with ~5-10s of Mikkel's voice to build a robust profile)
    POST /verify  {"samples": [float @16k], "sample_rate": 16000}  -> {"match": bool, "score": cos, "threshold": t}
    POST /reset   {}                                               -> {"ok": true}   (clear enrollment)
    GET  /health                                                   -> {"status": "ok", "enrolled": N, ...}

Setup (one-time, when you're OFF mobile data — this needs a download):
    py -3.12 -m pip install sherpa-onnx numpy
    # Download a speaker-embedding model, e.g. WeSpeaker ResNet34 (~27 MB), from:
    #   https://huggingface.co/csukuangfj/speaker-embedding-models   (or the sherpa-onnx releases)
    py -3.12 grace_speaker_server.py --model wespeaker_en_voxceleb_resnet34.onnx --port 8772
Then point Grace at it (in start-grace.ps1) and gate turns on it:
    set GRACE_SPEAKER_URL=http://localhost:8772
    set GRACE_SPEAKER_THRESHOLD=0.5

Integration: in the STT path (grace_whisper_server.py or GraceCore), after VAD and BEFORE dispatching
a turn, POST the utterance's 16k float samples to /verify; drop the turn if match is false. Bias the
threshold slightly strict — a false accept (Grace obeys a stranger) is worse than a false reject.
Speaker verification is language-independent, so the gate works for Danish and English alike.
"""
import sys
import os
import json
import math
import argparse
from http.server import HTTPServer, BaseHTTPRequestHandler

parser = argparse.ArgumentParser()
parser.add_argument('--model', default=os.environ.get('GRACE_SPEAKER_MODEL', ''),
                    help='path to a sherpa-onnx speaker-embedding .onnx (e.g. WeSpeaker ResNet34)')
parser.add_argument('--port', type=int, default=int(os.environ.get('GRACE_SPEAKER_PORT', '8772')))
parser.add_argument('--threshold', type=float, default=float(os.environ.get('GRACE_SPEAKER_THRESHOLD', '0.5')),
                    help='cosine-similarity accept threshold (0.5 default; raise to be stricter)')
parser.add_argument('--enroll-file', default=os.environ.get('GRACE_SPEAKER_ENROLL', 'data/speaker-enrollment.json'),
                    help='where the enrolled voiceprint is persisted')
args = parser.parse_args()

if not args.model or not os.path.isfile(args.model):
    print(f"[speaker] ERROR: model not found: {args.model!r}\n"
          f"[speaker] Download a WeSpeaker/ECAPA ONNX model and pass --model. See this file's docstring.",
          file=sys.stderr)
    sys.exit(2)

print(f"[speaker] loading {args.model} (sherpa-onnx, CPU)...", file=sys.stderr)
try:
    import sherpa_onnx  # noqa: E402
except Exception as e:  # pragma: no cover - environment-dependent
    print(f"[speaker] ERROR: sherpa-onnx not installed ({e}). Run: py -3.12 -m pip install sherpa-onnx numpy",
          file=sys.stderr)
    sys.exit(2)

_config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=args.model, num_threads=1, provider='cpu')
_extractor = sherpa_onnx.SpeakerEmbeddingExtractor(_config)


def embed(samples, sample_rate):
    """Return a unit-normalized speaker embedding for 16 kHz float samples."""
    stream = _extractor.create_stream()
    stream.accept_waveform(sample_rate=sample_rate, waveform=samples)
    stream.input_finished()
    if not _extractor.is_ready(stream):
        raise RuntimeError('not enough audio to compute a speaker embedding')
    vec = list(_extractor.compute(stream))
    return _normalize(vec)


def _normalize(v):
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def _cosine(a, b):
    # Both are unit vectors, so cosine == dot product.
    return sum(x * y for x, y in zip(a, b))


class Enrollment:
    """Holds the running mean voiceprint; persisted to disk so it survives restarts."""
    def __init__(self, path):
        self.path = path
        self.vectors = []   # individual enrollment embeddings
        self.mean = None    # unit-normalized mean
        self._load()

    def _load(self):
        try:
            with open(self.path, 'r', encoding='utf-8') as f:
                d = json.load(f)
            self.vectors = [list(map(float, v)) for v in d.get('vectors', [])]
            self._recompute()
        except Exception:
            self.vectors, self.mean = [], None

    def _save(self):
        try:
            os.makedirs(os.path.dirname(self.path) or '.', exist_ok=True)
            with open(self.path, 'w', encoding='utf-8') as f:
                json.dump({'vectors': self.vectors}, f)
        except Exception as e:
            print(f"[speaker] warn: could not persist enrollment: {e}", file=sys.stderr)

    def _recompute(self):
        if not self.vectors:
            self.mean = None
            return
        dim = len(self.vectors[0])
        acc = [0.0] * dim
        for v in self.vectors:
            for i in range(dim):
                acc[i] += v[i]
        self.mean = _normalize([x / len(self.vectors) for x in acc])

    def add(self, vec):
        self.vectors.append(vec)
        self._recompute()
        self._save()
        return len(self.vectors)

    def reset(self):
        self.vectors, self.mean = [], None
        self._save()


enrollment = Enrollment(args.enroll_file)
print(f"[speaker] ready on :{args.port} (enrolled={len(enrollment.vectors)}, threshold={args.threshold})",
      file=sys.stderr)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, data):
        body = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_samples(self):
        n = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(n))
        samples = body.get('samples')
        sr = int(body.get('sample_rate', 16000))
        if not isinstance(samples, list) or not samples:
            raise ValueError('samples (a non-empty float array @16k) is required')
        return [float(x) for x in samples], sr

    def do_GET(self):
        if self.path == '/health':
            self._json(200, {"status": "ok", "model": os.path.basename(args.model),
                             "enrolled": len(enrollment.vectors), "threshold": args.threshold})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        try:
            if self.path == '/enroll':
                samples, sr = self._read_samples()
                count = enrollment.add(embed(samples, sr))
                self._json(200, {"ok": True, "enrolled": count})
            elif self.path == '/verify':
                if enrollment.mean is None:
                    self._json(200, {"match": False, "score": 0.0, "threshold": args.threshold,
                                     "reason": "no voiceprint enrolled yet"})
                    return
                samples, sr = self._read_samples()
                score = _cosine(embed(samples, sr), enrollment.mean)
                self._json(200, {"match": bool(score >= args.threshold), "score": round(score, 4),
                                 "threshold": args.threshold})
            elif self.path == '/reset':
                enrollment.reset()
                self._json(200, {"ok": True})
            else:
                self._json(404, {"error": "not found"})
        except Exception as e:
            self._json(500, {"error": str(e)})


if __name__ == '__main__':
    HTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
