# Grace — Setup Guide

## Fase 0 (nu, på nuværende maskine eller ny)

```bash
# Installer Node.js 20+ fra nodejs.org

cd grace/
npm install          # Installer alle workspace-afhængigheder
npm run build        # Kompilér alle TypeScript-pakker
npm run dev          # Start overlay + mock pipeline
```

Genvej til at vise/skjule overlay: **Ctrl+Shift+G**

## Fase 1 (ny maskine — RTX 5090)

### 1. WSL2 + Python setup
```bash
wsl --install
# Åbn WSL terminal:
sudo apt update && sudo apt install python3.11 python3-pip ffmpeg
pip install faster-whisper silero-vad sounddevice
```

### 2. Ollama (første LLM backend)
```bash
# I Windows PowerShell:
winget install Ollama.Ollama
ollama pull gemma3:27b    # Start med 27B, skaler til 31B
```

### 3. Skift mock → rigtige services
I `packages/overlay/src/main.ts`:
```typescript
// Erstat:
import { MockSTT } from '@grace/stt';
import { MockLLM } from '@grace/llm';

// Med:
import { WhisperSTT } from '@grace/stt';
import { OllamaLLM } from '@grace/llm';
```

### 4. vLLM (fuld performance — Gemma 4 31B)
```bash
# I WSL2:
pip install vllm
vllm serve google/gemma-3-27b-it --port 8000
```

## Miljøvariabler

```env
GRACE_DEBUG=true          # Verbose EventBus logging
GRACE_LLM_PROVIDER=ollama # mock | ollama | vllm
GRACE_STT_PROVIDER=whisper # mock | whisper
GRACE_TTS_PROVIDER=mock    # mock | kokoro
```
