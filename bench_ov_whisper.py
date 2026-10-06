"""
Phase 0 spike — benchmark Whisper large-v3 across backends, NO changes to the live server.

Compares per-utterance latency of:
  - OpenVINO large-v3 (fp16 IR) on  Arc iGPU (GPU.0), NPU, CPU
  - faster-whisper large-v3 (CT2)  on  NVIDIA CUDA   (the current production path)

Reports BOTH the one-time compile/load cost (paid once at startup) and the steady-state
median latency (paid every turn). Usage:
  py -3.12 bench_ov_whisper.py [path-to-wav] [language]   # language e.g. da / en / auto
"""
import os, sys, time, statistics
import numpy as np
import soundfile as sf

WAV  = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "test.wav")
LANG = sys.argv[2] if len(sys.argv) > 2 else "auto"      # "auto" lets Whisper detect; Grace forces "da"
OV_MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "ov-whisper-large-v3-fp16")
FW_MODEL = "large-v3"
RUNS = 3

def load_audio_16k(path):
    audio, sr = sf.read(path, dtype="float32")
    if audio.ndim > 1:                      # stereo -> mono
        audio = audio.mean(axis=1)
    if sr != 16000:                         # Whisper wants 16 kHz
        import torch, torchaudio
        audio = torchaudio.functional.resample(torch.from_numpy(audio), sr, 16000).numpy()
    return np.ascontiguousarray(audio, dtype=np.float32)

def fmt(ms): return f"{ms:7.0f} ms"

def bench_openvino(device, audio):
    import openvino_genai as ov_genai
    t0 = time.perf_counter()
    pipe = ov_genai.WhisperPipeline(OV_MODEL, device=device)   # builds + compiles for the device
    construct_ms = (time.perf_counter() - t0) * 1000

    kw = {} if LANG == "auto" else {"language": f"<|{LANG}|>", "task": "transcribe"}
    def gen():
        try:
            return str(pipe.generate(audio, **kw))
        except TypeError:                    # older API: kwargs not accepted on generate
            return str(pipe.generate(audio))

    t0 = time.perf_counter(); text = gen(); first_ms = (time.perf_counter() - t0) * 1000  # includes lazy compile
    warm = []
    for _ in range(RUNS):
        t0 = time.perf_counter(); text = gen(); warm.append((time.perf_counter() - t0) * 1000)
    return construct_ms, first_ms, statistics.median(warm), text.strip()

def bench_faster_whisper(audio):
    from faster_whisper import WhisperModel
    t0 = time.perf_counter()
    m = WhisperModel(FW_MODEL, device="cuda", compute_type="float16")
    load_ms = (time.perf_counter() - t0) * 1000
    lang = None if LANG == "auto" else LANG
    def gen():
        segs, _ = m.transcribe(audio, language=lang, beam_size=5, vad_filter=False)
        return " ".join(s.text.strip() for s in segs).strip()
    t0 = time.perf_counter(); text = gen(); first_ms = (time.perf_counter() - t0) * 1000
    warm = []
    for _ in range(RUNS):
        t0 = time.perf_counter(); text = gen(); warm.append((time.perf_counter() - t0) * 1000)
    return load_ms, first_ms, statistics.median(warm), text.strip()

def main():
    audio = load_audio_16k(WAV)
    dur = len(audio) / 16000
    print(f"\nClip: {WAV}\n  {dur:.2f}s @16kHz mono | language={LANG} | {RUNS} timed runs each\n")
    print(f"{'backend':<34}{'compile/load':>14}{'1st run':>12}{'warm median':>14}   transcript")
    print("-" * 110)

    rows = [
        ("OpenVINO large-v3  · Arc iGPU (GPU.0)", lambda: bench_openvino("GPU.0", audio)),
        ("OpenVINO large-v3  · NPU",             lambda: bench_openvino("NPU",   audio)),
        ("OpenVINO large-v3  · CPU",             lambda: bench_openvino("CPU",   audio)),
        ("faster-whisper large-v3 · CUDA (now)", lambda: bench_faster_whisper(audio)),
    ]
    for name, fn in rows:
        try:
            construct, first, warm, text = fn()
            print(f"{name:<34}{fmt(construct):>14}{fmt(first):>12}{fmt(warm):>14}   {text[:60]!r}")
        except Exception as e:
            print(f"{name:<34}{'FAILED':>14}   {type(e).__name__}: {str(e)[:80]}")
    print()

if __name__ == "__main__":
    main()
