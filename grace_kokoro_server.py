#!/usr/bin/env python3
"""
grace_kokoro_server.py - Grace TTS backend (Kokoro-82M, fully local)
====================================================================
Fast neural TTS using Kokoro-82M with a female English voice (af_heart).
Mikkel speaks Danish (Whisper handles that); Grace replies in English with
this voice. Model downloads once (~330MB) then runs 100% offline.

Endpoints:
  GET  /health      -> {"status":"ok","engine":"kokoro","voice":"af_heart","sample_rate":24000}
  POST /synthesize  -> WAV bytes   Body: {"text":"...","voice":"af_heart","speed":1.0}
  GET  /voices      -> available female voices

Deps (already installed): kokoro, misaki[en], soundfile, numpy (+ spaCy en_core_web_sm).

Usage:
  py -3.12 grace_kokoro_server.py --port 8765 --voice af_heart
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
parser.add_argument('--port',  type=int,   default=8765,     help='HTTP port')
parser.add_argument('--voice', default='af_heart',           help='Kokoro voice (af_heart = female US English)')
parser.add_argument('--lang',  default='a',                  help="Kokoro lang_code: 'a'=US English, 'b'=UK English")
parser.add_argument('--speed', type=float, default=1.0,      help='Speech speed multiplier')
args = parser.parse_args()

SAMPLE_RATE = 24000  # Kokoro outputs 24 kHz

# -- Load Kokoro --------------------------------------------------------------
try:
    from kokoro import KPipeline
except ImportError as e:
    print(f"[TTS] Missing dependency: {e}", file=sys.stderr)
    print('[TTS] Install: py -3.12 -m pip install kokoro "misaki[en]" soundfile', file=sys.stderr)
    sys.exit(1)

print(f"[TTS] Loading Kokoro-82M (lang={args.lang}, voice={args.voice})...", file=sys.stderr)
try:
    # Use the GPU when torch sees CUDA — far faster synth, so multi-sentence
    # replies stop lagging between sentences. Falls back to CPU otherwise.
    try:
        import torch
        _device = 'cuda' if torch.cuda.is_available() else 'cpu'
    except Exception:
        _device = 'cpu'
    print(f"[TTS] Kokoro device: {_device}", file=sys.stderr)
    pipeline = KPipeline(lang_code=args.lang, repo_id='hexgrad/Kokoro-82M', device=_device)
    # Warm up so the first real request isn't slow.
    for _ in pipeline('Ready.', voice=args.voice):
        pass
    print(f"[TTS] Kokoro ready -- {args.voice} @ {SAMPLE_RATE}Hz", file=sys.stderr)
except Exception as e:
    print(f"[TTS] FATAL: could not load Kokoro: {e}", file=sys.stderr)
    sys.exit(1)

# -- Synthesis ----------------------------------------------------------------
def synthesize_audio(text: str, voice: str, speed: float):
    chunks = [np.asarray(a, dtype=np.float32)
              for _, _, a in pipeline(text, voice=voice, speed=speed)]
    return np.concatenate(chunks) if chunks else np.zeros(1, dtype=np.float32)


# Persistent output stream for /speak — keeps the audio device open so playback
# does not re-acquire (and re-glitch) the Bluetooth device on every clip.
_out_stream = None

def play_audio(audio) -> bool:
    global _out_stream
    try:
        import sounddevice as sd
        if _out_stream is None:
            _out_stream = sd.OutputStream(samplerate=SAMPLE_RATE, channels=1, dtype='float32')
            _out_stream.start()
        _out_stream.write(np.ascontiguousarray(np.clip(audio, -1.0, 1.0), dtype=np.float32))
        return True
    except Exception as e:
        print(f"[TTS] /speak playback failed: {e}", file=sys.stderr)
        return False


def synthesize(text: str, voice: str, speed: float) -> bytes:
    audio = synthesize_audio(text, voice, speed)
    pcm16 = (np.clip(audio, -1.0, 1.0) * 32767.0).astype('<i2')
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm16.tobytes())
    return buf.getvalue()

# -- HTTP handler (same API as the old Piper server -> KokoroTTS.ts unchanged) -
class TTSHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        pass

    def send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = urlparse(self.path).path
        if p == '/health':
            self.send_json(200, {'status': 'ok', 'engine': 'kokoro',
                                 'voice': args.voice, 'sample_rate': SAMPLE_RATE})
        elif p == '/voices':
            self.send_json(200, {'voices': [
                {'id': 'af_heart', 'name': 'Heart (US female)', 'engine': 'kokoro', 'language': 'en-US'},
                {'id': 'af_bella', 'name': 'Bella (US female)', 'engine': 'kokoro', 'language': 'en-US'},
                {'id': 'bf_emma',  'name': 'Emma (UK female)',  'engine': 'kokoro', 'language': 'en-GB'},
            ]})
        else:
            self.send_json(404, {'error': 'Not found'})

    def do_POST(self):
        p = urlparse(self.path).path
        if p not in ('/synthesize', '/speak'):
            self.send_json(404, {'error': 'Not found'})
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
            text = (body.get('text') or '').strip()
            voice = body.get('voice') or args.voice
            speed = float(body.get('speed', args.speed))
            if not text:
                self.send_json(400, {'error': 'No text provided'})
                return
            # Kokoro is English-only; ignore leftover Danish/Piper voice names.
            if not voice or voice.startswith('da_'):
                voice = args.voice
            print(f"[TTS] ({p} {voice}) {text[:80]}", file=sys.stderr)
            if p == '/speak':
                # Synthesize AND play on the server via a persistent stream.
                ok = play_audio(synthesize_audio(text, voice, speed))
                self.send_json(200 if ok else 500, {'played': ok})
                return
            wav = synthesize(text, voice, speed)
            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(wav)))
            self.end_headers()
            self.wfile.write(wav)
            print(f"[TTS] Sent {len(wav):,} bytes", file=sys.stderr)
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self.send_json(500, {'error': str(e)})


if __name__ == '__main__':
    srv = HTTPServer(('127.0.0.1', args.port), TTSHandler)
    print(f"Grace TTS (Kokoro) listening on http://127.0.0.1:{args.port}", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[TTS] Shutting down.", file=sys.stderr)
