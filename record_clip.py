"""Record an 8s mono 16kHz clip from the mic for benchmarking. Uses Grace's configured
mic (GRACE_MIC_NAME, default 'Realtek') so the audio matches production STT conditions.

  py -3.12 record_clip.py            # records 8s -> danish_test.wav
  py -3.12 record_clip.py 12 my.wav  # 12s -> my.wav
"""
import sys, os
import sounddevice as sd
import soundfile as sf

SECONDS = int(sys.argv[1]) if len(sys.argv) > 1 else 8
OUT     = sys.argv[2] if len(sys.argv) > 2 else "danish_test.wav"
SR      = 16000
MIC_HINT = os.environ.get("GRACE_MIC_NAME", "Realtek").lower()

# Pick the input device whose name contains the hint (matches Grace's selection logic)
dev = None
for i, d in enumerate(sd.query_devices()):
    if d["max_input_channels"] > 0 and MIC_HINT in d["name"].lower():
        dev = i; print(f"[mic] using [{i}] {d['name']}"); break
if dev is None:
    print(f"[mic] no device matching '{MIC_HINT}', using default input")

print(f"\n>>> RECORDING {SECONDS}s — speak Danish now! <<<\n")
audio = sd.rec(int(SECONDS * SR), samplerate=SR, channels=1, dtype="float32", device=dev)
sd.wait()
sf.write(OUT, audio, SR)
peak = float(abs(audio).max())
print(f"saved {OUT}  ({SECONDS}s @ {SR}Hz, peak level {peak:.2f})")
if peak < 0.05:
    print("WARNING: very low level — mic may be muted or too far away.")
