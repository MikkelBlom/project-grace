#!/bin/bash
# Downloads + converts Grace's recommended models (docs/6-MODEL-UPGRADES.md). Continues past
# individual failures; every step's exit code is logged. Run in the background; tail logs/model-fetch.log.
set +e
cd "/c/Users/mikke/Documents/Claude/Projects/AI automation/grace" || exit 1
LOG="logs/model-fetch.log"
mkdir -p logs models
SCRIPTS="C:/Users/mikke/AppData/Local/Programs/Python/Python312/Scripts"

echo "=== model fetch START $(date) ===" > "$LOG"

echo "[1/4] pip deps (optimum-intel[openvino], openvino-genai, fastembed)..." >> "$LOG"
py -3.12 -m pip install --upgrade "optimum-intel[openvino]" openvino-genai fastembed >> "$LOG" 2>&1
echo "[1/4] pip exit=$?" >> "$LOG"

echo "[2/4] STT: CoRal Roest-v3-whisper-1.5b -> OpenVINO fp16 (this is the big one)..." >> "$LOG"
"$SCRIPTS/optimum-cli" export openvino --model CoRal-project/roest-v3-whisper-1.5b \
  --task automatic-speech-recognition-with-past --weight-format fp16 \
  models/ov-roest-v3-whisper-1.5b-fp16 >> "$LOG" 2>&1
echo "[2/4] optimum-cli exit=$?" >> "$LOG"
ls -la models/ov-roest-v3-whisper-1.5b-fp16 >> "$LOG" 2>&1

echo "[3/4] embedder: pre-download multilingual-e5-base (fastembed)..." >> "$LOG"
py -3.12 -c "from fastembed import TextEmbedding; TextEmbedding('intfloat/multilingual-e5-base'); print('e5 ready')" >> "$LOG" 2>&1
echo "[3/4] fastembed exit=$?" >> "$LOG"

echo "[4/4] Danish TTS: Piper da_DK-talesyntese-medium voice..." >> "$LOG"
mkdir -p models/piper
curl -sL -o models/piper/da_DK-talesyntese-medium.onnx \
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/da/da_DK/talesyntese/medium/da_DK-talesyntese-medium.onnx" >> "$LOG" 2>&1
curl -sL -o models/piper/da_DK-talesyntese-medium.onnx.json \
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/da/da_DK/talesyntese/medium/da_DK-talesyntese-medium.onnx.json" >> "$LOG" 2>&1
py -3.12 -m pip install --upgrade piper-tts >> "$LOG" 2>&1
ls -la models/piper >> "$LOG" 2>&1
echo "[4/4] piper done" >> "$LOG"

echo "=== model fetch DONE $(date) ===" >> "$LOG"
