"""Transcribe one wav with ONE backend (separate process avoids OV+CUDA conflict).
  py -3.12 transcribe_one.py <wav> ov  GPU.0   # OpenVINO fp16 on a device
  py -3.12 transcribe_one.py <wav> fw          # faster-whisper CUDA (current prod path)
"""
import sys, time, statistics
import numpy as np, soundfile as sf

WAV     = sys.argv[1]
BACKEND = sys.argv[2]
DEVICE  = sys.argv[3] if len(sys.argv) > 3 else "GPU.0"
LANG    = "da"
import os
OV_MODEL = os.environ.get("GRACE_OV_MODEL", os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "ov-whisper-large-v3-fp16"))
RUNS = 3

a, sr = sf.read(WAV, dtype="float32")
if a.ndim > 1: a = a.mean(axis=1)
if sr != 16000:
    import torch, torchaudio
    a = torchaudio.functional.resample(torch.from_numpy(a), sr, 16000).numpy()
a = np.ascontiguousarray(a, dtype=np.float32)
print(f"clip {len(a)/16000:.2f}s | backend={BACKEND} device={DEVICE if BACKEND=='ov' else 'cuda'} lang={LANG}")

if BACKEND == "ov":
    import openvino_genai as g
    t0 = time.perf_counter(); pipe = g.WhisperPipeline(OV_MODEL, device=DEVICE)
    gen = lambda: str(pipe.generate(a, language=f"<|{LANG}|>", task="transcribe"))
    t1 = time.perf_counter(); text = gen(); compile_ms = (time.perf_counter()-t0)*1000; first_ms=(time.perf_counter()-t1)*1000
else:
    from faster_whisper import WhisperModel
    t0 = time.perf_counter(); m = WhisperModel("large-v3", device="cuda", compute_type="float16")
    def gen():
        segs,_ = m.transcribe(a, language=LANG, beam_size=5, vad_filter=False,
                              initial_prompt="Samtale med Grace, en dansk AI-assistent. Hej Grace.")
        return " ".join(s.text.strip() for s in segs).strip()
    t1 = time.perf_counter(); text = gen(); compile_ms=(time.perf_counter()-t0)*1000; first_ms=(time.perf_counter()-t1)*1000

warm = []
for _ in range(RUNS):
    t = time.perf_counter(); text = gen(); warm.append((time.perf_counter()-t)*1000)
print(f"compile/load+1st: {compile_ms:.0f} ms | warm median/turn: {statistics.median(warm):.0f} ms")
print(f"TEXT: {text!r}")
