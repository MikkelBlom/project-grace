# Grace — Setup Guide

## Fase 0 (nu, på nuværende maskine eller ny)

```bash
# Installer Node.js 24 fra nodejs.org
# Installer Python 3.12 (kaldes via 'py -3.12') fra python.org

cd grace/
npm install          # Installer alle workspace-afhængigheder
npm run build        # Kompilér alle TypeScript-pakker
npm run dev          # Start overlay + mock pipeline
```

Genvej til at vise/skjule overlay: **Ctrl+Shift+G**

## Fase 1 (RTX 5090 Laptop — Windows 11 native)

Grace kører **nativt på Windows 11** (ikke WSL2). Launcheren `start-grace.ps1` sætter alle
providers/miljøvariabler, starter Ollama + Kokoro TTS i baggrunden og åbner Electron-appen.

### 1. Python + STT/TTS-afhængigheder
```powershell
# Windows PowerShell — Python 3.12 fra python.org (py-launcheren skal virke)
py -3.12 -m pip install silero-vad sounddevice numpy torch
py -3.12 -m pip install faster-whisper                    # CUDA-fallback til STT
py -3.12 -m pip install openvino-genai                    # OpenVINO-backend (Intel Arc iGPU)
py -3.12 -m pip install kokoro "misaki[en]" soundfile     # Kokoro TTS
```

STT kører som standard på **OpenVINO-backenden** (`--backend openvino`) med Whisper `large-v3`
fp16 på **Intel Arc 140T iGPU'en** (device `GPU.0`), så RTX'en holdes fri til LLM'en. Dansk
tvinges (`GRACE_WHISPER_LANG=da`). `faster-whisper` på CUDA er kun en fallback-sti. Se
`docs/6-MODEL-UPGRADES.md` for konvertering af OpenVINO-modeller (og den planlagte danske Røst-v3 STT).

### 2. Ollama (LLM-backend)
```powershell
winget install Ollama.Ollama
ollama pull gemma4:26b     # multimodal — samme model laver også vision (box_2d)
```

### 3. Start Grace
```powershell
./start-grace.ps1
```
Launcheren vælger de rigtige services via **miljøvariabler** (ikke kodeændringer):
`GRACE_LLM_PROVIDER=ollama`, `GRACE_STT_PROVIDER=whisper`, `GRACE_TTS_PROVIDER=kokoro`.
Mock-pipelinen (`npm run dev` alene) bruges kun til UI-arbejde uden modellerne.

### 4. Valgfri lokale services (Docker)
```powershell
# Lokal web-søgning (SearXNG) — web_search/research bruger den før DuckDuckGo-fallback
docker compose -f docker/searxng/docker-compose.yml up -d
# Vektor-hukommelse (ChromaDB, pinned 0.4.24) — Grace starter den selv hvis Docker kører
docker compose -f docker/chroma/docker-compose.yml up -d
```
Begge er nice-to-have: uden SearXNG falder søgning tilbage til DuckDuckGo, og uden ChromaDB
falder hukommelsen tilbage på lokal sqlite/JSON.

## Miljøvariabler

```env
GRACE_LLM_PROVIDER=ollama    # mock | ollama
GRACE_STT_PROVIDER=whisper   # mock | whisper
GRACE_TTS_PROVIDER=kokoro    # mock | kokoro
GRACE_LLM_MODEL=gemma4:26b   # Ollama-model (multimodal)
GRACE_STT_BACKEND=openvino   # openvino (Arc iGPU) | faster-whisper (CUDA-fallback)
GRACE_OV_MODEL=...\models\ov-whisper-large-v3-fp16   # OpenVINO IR-model
GRACE_OV_DEVICE=GPU.0        # Intel Arc iGPU
GRACE_WHISPER_MODEL=large-v3
GRACE_WHISPER_LANG=da        # dansk tvinges
GRACE_MIC_NAME=USB Audio Device
GRACE_PYTHON_CMD=py
GRACE_REPO_ROOT=<grace-mappen>              # så tools finder config/data pålideligt
GRACE_SEARCH_URL=http://localhost:8888      # SearXNG (web_search/research)
GRACE_DEFAULT_LANGUAGE=en    # da | en — standardsprog ved opstart
GRACE_TTS_DA_URL=            # dansk TTS-backend (planlagt; se docs/6)
GRACE_DEBUG=true             # Verbose EventBus logging
```
