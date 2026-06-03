#!/usr/bin/env python3
"""
grace_whisper_server.py — Grace STT backend
============================================
Captures microphone audio, runs silero-VAD to filter silence,
transcribes speech with faster-whisper, and streams JSON lines to stdout.

Output protocol (one JSON object per line):
  {"type": "ready"}                          — model loaded, listening
  {"type": "vad", "has_voice": true/false}   — VAD state change
  {"type": "transcript", "text": "...",
   "confidence": 0.95, "language": "da"}     — transcription result
  {"type": "error", "error": "..."}          — non-fatal error

Requirements (install in WSL2):
  pip install faster-whisper silero-vad sounddevice numpy torch

Usage:
  python3 grace_whisper_server.py --model large-v3 --device cuda --lang da
"""

import sys
import os
import json
import argparse
import threading
import queue
import time
import numpy as np

# ── Fix: add nvidia CUDA DLL directories to PATH before importing CTranslate2 ──
# pip install nvidia-cublas-cu12 puts DLLs in site-packages/nvidia/*/bin/
# but CTranslate2 won't find them unless they're on PATH.
def _add_nvidia_dlls_to_path():
    try:
        import site
        for sp in site.getsitepackages():
            nvidia_dir = os.path.join(sp, 'nvidia')
            if not os.path.isdir(nvidia_dir):
                continue
            for pkg in os.listdir(nvidia_dir):
                bin_dir = os.path.join(nvidia_dir, pkg, 'bin')
                if os.path.isdir(bin_dir) and bin_dir not in os.environ.get('PATH', ''):
                    os.environ['PATH'] = bin_dir + os.pathsep + os.environ.get('PATH', '')
                    print(f"[CUDA] Added to PATH: {bin_dir}", file=sys.stderr)
    except Exception as e:
        print(f"[CUDA] DLL path setup skipped: {e}", file=sys.stderr)

_add_nvidia_dlls_to_path()

# ── Parse args ────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description='Grace Whisper STT server')
parser.add_argument('--model',  default='large-v3', help='Whisper model size')
parser.add_argument('--device', default='cuda',     help='cuda or cpu')
parser.add_argument('--lang',   default='da',       help='Language code or "auto"')
parser.add_argument('--sample-rate', type=int, default=16000, help='Audio sample rate')
parser.add_argument('--chunk-ms',    type=int, default=30,    help='Audio chunk size in ms (ignored — fixed at 512 samples)')
parser.add_argument('--mic-device',  type=int, default=-1,    help='Sounddevice input device index (-1 = auto)')
parser.add_argument('--vad-threshold', type=float, default=0.3, help='VAD sensitivity (0–1)')
parser.add_argument('--min-speech-ms', type=int, default=300,  help='Minimum speech duration')
parser.add_argument('--silence-ms',    type=int, default=500,  help='Silence before transcript emit')
args = parser.parse_args()

SAMPLE_RATE    = args.sample_rate
# silero-VAD v4 requires EXACTLY 512 samples at 16kHz (32ms) or 256 at 8kHz.
# Using 480 (30ms) always returns ~0. Do not change this.
CHUNK_SAMPLES  = 512 if SAMPLE_RATE == 16000 else 256
VAD_THRESHOLD  = args.vad_threshold
MIN_SPEECH_SAMPLES = int(SAMPLE_RATE * args.min_speech_ms / 1000)
SILENCE_SAMPLES    = int(SAMPLE_RATE * args.silence_ms / 1000)

# ── JSON output helpers ────────────────────────────────────────────────────────

def emit(obj: dict):
    """Write a JSON line to stdout (thread-safe via flush)."""
    print(json.dumps(obj, ensure_ascii=False), flush=True)

def emit_ready():
    emit({"type": "ready"})

def emit_vad(has_voice: bool):
    emit({"type": "vad", "has_voice": has_voice})

def emit_transcript(text: str, confidence: float, language: str):
    emit({"type": "transcript", "text": text, "confidence": confidence, "language": language})

def emit_error(error: str):
    emit({"type": "error", "error": error})

# ── Load models ────────────────────────────────────────────────────────────────

def load_models():
    # Suppress stdout during model loading
    import io, contextlib

    print("Loading silero-VAD...", file=sys.stderr)
    try:
        import torch
        vad_model, utils = torch.hub.load(
            repo_or_dir='snakers4/silero-vad',
            model='silero_vad',
            force_reload=False,
            onnx=False,
        )
        get_speech_probs = utils[0]
        print("silero-VAD loaded.", file=sys.stderr)
    except Exception as e:
        emit_error(f"silero-VAD load failed: {e}")
        sys.exit(1)

    print(f"Loading faster-whisper ({args.model}, {args.device})...", file=sys.stderr)
    try:
        from faster_whisper import WhisperModel

        # Use non-zero noise for warm-up — silence bypasses cuBLAS, real audio doesn't.
        # This correctly detects missing cuBLAS at startup instead of first utterance.
        rng = np.random.default_rng(42)
        test_audio = rng.standard_normal(SAMPLE_RATE).astype(np.float32) * 0.05

        whisper_model = None
        for device, ctype in [
            (args.device, "int8"),          # CUDA int8 — no cuBLAS dependency, works on any CUDA GPU
            (args.device, "int8_float16"),  # int8_float16 — needs cuBLAS, only if above fails
            ("cpu",       "int8"),          # CPU fallback — always works, but slow on large-v3
        ]:
            try:
                print(f"  Prøver {device}/{ctype}...", file=sys.stderr)
                m = WhisperModel(args.model, device=device, compute_type=ctype)
                # Warm-up with beam_size=5 — MUST match real inference beam size.
                # beam_size=1 skips code paths that trigger cuBLAS; mismatch caused
                # warm-up to pass but real transcription to fail.
                list(m.transcribe(test_audio, language='da', beam_size=5))
                whisper_model = m
                print(f"faster-whisper klar ({args.model}, {device}/{ctype}).", file=sys.stderr)
                break
            except Exception as e:
                err = str(e)
                if 'cublas' in err.lower() or 'dll' in err.lower():
                    print(f"  {device}/{ctype}: cuBLAS runtime fejl — prøver næste", file=sys.stderr)
                else:
                    print(f"  {device}/{ctype} fejlede: {e}", file=sys.stderr)

        if whisper_model is None:
            emit_error("faster-whisper: alle compute-typer fejlede")
            sys.exit(1)
    except Exception as e:
        emit_error(f"faster-whisper load failed: {e}")
        sys.exit(1)

    return vad_model, get_speech_probs, whisper_model

# ── Audio capture + VAD + Whisper pipeline ─────────────────────────────────────

def find_best_input_device(sd):
    """Find the best microphone device — prefer the Windows default, log all options."""
    # Virtual/shared devices that never have real audio — skip these
    VIRTUAL_KEYWORDS = ['glidex', 'shared', 'virtual', 'mapper', 'primary', 'loopback', 'wave out']
    # Preferred physical mic keywords (matched case-insensitively)
    PREFER_KEYWORDS  = ['realtek', 'array', 'mikrofon', 'microphone', 'input', 'bth', 'usb']

    # If GRACE_MIC_NAME env var is set, use it to find the device by name substring
    mic_name_filter = os.environ.get('GRACE_MIC_NAME', '').lower()

    devices = sd.query_devices()
    print("\n[Mic] Tilgængelige input-enheder:", file=sys.stderr)
    input_devices = []
    for i, d in enumerate(devices):
        if d['max_input_channels'] > 0:
            marker = " ← Windows default" if i == sd.default.device[0] else ""
            print(f"  [{i}] {d['name']}{marker}", file=sys.stderr)
            input_devices.append(i)

    def is_virtual(name): return any(k in name.lower() for k in VIRTUAL_KEYWORDS)
    def is_preferred(name): return any(k in name.lower() for k in PREFER_KEYWORDS)

    # 1. If GRACE_MIC_NAME is set, find first matching device
    if mic_name_filter:
        for i in input_devices:
            if mic_name_filter in devices[i]['name'].lower():
                print(f"[Mic] Env-valgt enhed [{i}]: {devices[i]['name']}", file=sys.stderr)
                return i
        print(f"[Mic] ⚠ GRACE_MIC_NAME='{mic_name_filter}' ikke fundet — falder tilbage", file=sys.stderr)

    # 2. Use Windows default only if it's not a virtual device
    default_idx = sd.default.device[0]
    if default_idx in input_devices and not is_virtual(devices[default_idx]['name']):
        print(f"[Mic] Windows default [{default_idx}]: {devices[default_idx]['name']}", file=sys.stderr)
        return default_idx

    # 3. Windows default was virtual — find best physical mic
    if is_virtual(devices[default_idx]['name']):
        print(f"[Mic] ⚠ Windows default er virtuel ({devices[default_idx]['name']}) — søger fysisk mikrofon", file=sys.stderr)

    for i in input_devices:
        name = devices[i]['name']
        if not is_virtual(name) and is_preferred(name):
            print(f"[Mic] Valgte fysisk mikrofon [{i}]: {name}", file=sys.stderr)
            return i

    # 4. Any non-virtual input
    for i in input_devices:
        if not is_virtual(devices[i]['name']):
            print(f"[Mic] Fallback [{i}]: {devices[i]['name']}", file=sys.stderr)
            return i

    print(f"[Mic] ⚠ Ingen brugbar mikrofon fundet!", file=sys.stderr)
    return None

def run_pipeline(vad_model, get_speech_probs, whisper_model):
    try:
        import sounddevice as sd
        import torch
    except ImportError as e:
        emit_error(f"Missing package: {e}")
        sys.exit(1)

    mic_device = args.mic_device if args.mic_device >= 0 else find_best_input_device(sd)

    audio_queue: queue.Queue[np.ndarray] = queue.Queue()
    speech_buffer: list[np.ndarray] = []
    silence_counter = 0
    was_speaking = False

    def audio_callback(indata, frames, time_info, status):
        if status:
            print(f"[sounddevice] {status}", file=sys.stderr)
        audio_queue.put(indata[:, 0].copy())  # Mono

    emit_ready()

    with sd.InputStream(
        device=mic_device,
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype='float32',
        blocksize=CHUNK_SAMPLES,
        callback=audio_callback,
    ):
        dev_name = sd.query_devices(mic_device)['name'] if mic_device is not None else "default"
        print(f"[Mic] Lytter på: {dev_name} (rate={SAMPLE_RATE}Hz, chunk={CHUNK_SAMPLES})", file=sys.stderr)
        print(f"[VAD] Threshold: {VAD_THRESHOLD} — snak tydeligt og hold mikrofon tæt på", file=sys.stderr)

        log_counter = 0

        while True:
            try:
                chunk = audio_queue.get(timeout=1.0)
            except queue.Empty:
                continue

            # ── VAD ──────────────────────────────────────────────────────
            tensor = torch.from_numpy(chunk)
            try:
                speech_prob = vad_model(tensor, SAMPLE_RATE).item()
            except Exception:
                speech_prob = 0.0

            # Log VAD probability + RMS every ~2 seconds so we can diagnose mic issues
            log_counter += 1
            if log_counter % 62 == 0:  # ~2s at 512-sample chunks
                rms = float(np.sqrt(np.mean(chunk ** 2)))
                vad_bar = '█' * int(speech_prob * 20)
                rms_bar = '█' * min(20, int(rms * 200))
                print(f"[VAD] prob={speech_prob:.2f} |{vad_bar:<20}|  RMS={rms:.4f} |{rms_bar:<20}| {'🗣 TALE' if speech_prob >= VAD_THRESHOLD else ''}", file=sys.stderr)

            is_speaking = speech_prob >= VAD_THRESHOLD

            if is_speaking != was_speaking:
                emit_vad(is_speaking)
                was_speaking = is_speaking

            if is_speaking:
                speech_buffer.append(chunk)
                silence_counter = 0
            elif speech_buffer:
                silence_counter += CHUNK_SAMPLES

                if silence_counter >= SILENCE_SAMPLES:
                    # Enough silence — transcribe
                    audio_np = np.concatenate(speech_buffer)
                    speech_buffer.clear()
                    silence_counter = 0

                    if len(audio_np) < MIN_SPEECH_SAMPLES:
                        continue  # Too short — ignore

                    transcribe(whisper_model, audio_np)

# Global CPU fallback model — created on first cuBLAS runtime failure
_cpu_fallback_model = None

def _do_transcribe(model, audio_np):
    """Run one transcription and return (full_text, language, confidence)."""
    lang_arg = None if args.lang == 'auto' else args.lang
    segments, info = model.transcribe(
        audio_np,
        language=lang_arg,
        beam_size=5,
        vad_filter=False,
        word_timestamps=False,
        # Bias recognition toward Grace's name + Danish context so "Grace"
        # isn't mis-heard as "Gris"/"Grys"/"Greis" etc.
        initial_prompt="Samtale med Grace, en dansk AI-assistent. Hej Grace.",
        # ── Hallucination suppression ──────────────────────────────────────
        # Without these, Whisper invents plausible-sounding text on silence
        # or very quiet audio (e.g. "Danske tekster af Nicolai Winther").
        no_speech_threshold=0.6,         # Discard if model thinks it's silence
        log_prob_threshold=-0.5,         # Discard low-confidence output
        compression_ratio_threshold=2.4, # Discard repetitive/looping output
    )
    # Consume generator once
    segs_list = list(segments)
    full_text = ' '.join(seg.text.strip() for seg in segs_list).strip()
    confidence = 0.85
    return full_text, info.language or args.lang, confidence

def transcribe(whisper_model, audio_np: np.ndarray):
    """Run Whisper on audio buffer and emit transcript. Falls back to CPU if CUDA fails."""
    global _cpu_fallback_model
    # Once cuBLAS has failed once, the CUDA model can HANG on reuse — which froze
    # Grace after a single turn. After the first fallback, use the CPU model directly.
    active_model = _cpu_fallback_model if _cpu_fallback_model is not None else whisper_model
    try:
        full_text, language, confidence = _do_transcribe(active_model, audio_np)
        if not full_text:
            return
        emit_transcript(text=full_text, confidence=confidence, language=language)

    except Exception as e:
        err = str(e)
        if 'cublas' in err.lower() or 'dll' in err.lower():
            # cuBLAS runtime failure — load CPU fallback once and use it
            if _cpu_fallback_model is None:
                print("[Whisper] cuBLAS fejl — lader CPU-model (kun én gang)...", file=sys.stderr)
                try:
                    from faster_whisper import WhisperModel
                    _cpu_fallback_model = WhisperModel(args.model, device='cpu', compute_type='int8')
                    print("[Whisper] CPU-model klar.", file=sys.stderr)
                except Exception as load_err:
                    emit_error(f"CPU fallback load fejlede: {load_err}")
                    return
            # Retry with CPU model
            try:
                full_text, language, confidence = _do_transcribe(_cpu_fallback_model, audio_np)
                if full_text:
                    emit_transcript(text=full_text, confidence=confidence, language=language)
            except Exception as retry_err:
                emit_error(f"CPU transskription fejlede: {retry_err}")
        else:
            emit_error(f"Transcription error: {e}")

# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    try:
        vad_model, get_speech_probs, whisper_model = load_models()
        run_pipeline(vad_model, get_speech_probs, whisper_model)
    except KeyboardInterrupt:
        print("Shutting down.", file=sys.stderr)
        sys.exit(0)
    except Exception as e:
        emit_error(f"Fatal: {e}")
        sys.exit(1)
