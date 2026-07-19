#!/usr/bin/env python3
"""
grace_da_tts_server.py — Danish TTS for Grace (Piper), exposing the SAME HTTP API as the Kokoro
server, so GRACE_TTS_DA_URL can point here and KokoroTTS routes Danish replies to it automatically.

Setup:
    py -3.12 -m pip install piper-tts sounddevice numpy
    (voice files: models/piper/da_DK-talesyntese-medium.onnx + .onnx.json — see scripts/fetch-models.sh)
Run:
    py -3.12 grace_da_tts_server.py --port 8766
Then in start-grace.ps1:
    $env:GRACE_TTS_DA_URL = "http://localhost:8766"

Endpoints (match grace_kokoro_server.py):
    GET  /health      -> {"status":"ok","engine":"piper","voice":"...","sample_rate":N}
    POST /synthesize  -> WAV bytes    {"text":"...","voice":"...","speed":1.0}
    POST /speak       -> plays on the server, returns {"played": true}
"""
import sys
import io
import json
import wave
import argparse
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=8766)
parser.add_argument('--model', default='models/piper/da_DK-talesyntese-medium.onnx')
args = parser.parse_args()

print(f"[da-tts] loading Piper {args.model}...", file=sys.stderr)
from piper import PiperVoice  # noqa: E402

voice = PiperVoice.load(args.model)
SAMPLE_RATE = voice.config.sample_rate
print(f"[da-tts] ready @ {SAMPLE_RATE}Hz on :{args.port}", file=sys.stderr)


def synth_wav(text: str) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        voice.synthesize(text, w)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == '/health':
            self._json(200, {"status": "ok", "engine": "piper", "voice": "da_DK-talesyntese-medium", "sample_rate": SAMPLE_RATE})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        p = urlparse(self.path).path
        if p not in ('/synthesize', '/speak'):
            self._json(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(n))
            text = (body.get('text') or '').strip()
            if not text:
                self._json(400, {"error": "no text provided"})
                return
            wav = synth_wav(text)
            if p == '/speak':
                try:
                    import sounddevice as sd
                    with wave.open(io.BytesIO(wav), 'rb') as wf:
                        frames = wf.readframes(wf.getnframes())
                    audio = np.frombuffer(frames, dtype='<i2').astype(np.float32) / 32768.0
                    sd.play(audio, SAMPLE_RATE)
                    sd.wait()
                    self._json(200, {"played": True})
                except Exception as e:
                    self._json(500, {"error": str(e)})
                return
            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(wav)))
            self.end_headers()
            self.wfile.write(wav)
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._json(500, {"error": str(e)})


if __name__ == '__main__':
    HTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
