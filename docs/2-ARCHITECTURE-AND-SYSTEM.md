# Grace — Architecture & System

Read this before implementing anything. It explains the layout, the data flow, and the conventions.

## Stack
- **Electron** app (`packages/overlay`) hosts the main process and HUD UI.
- **TypeScript monorepo** (npm workspaces + TS project references, build via `tsc -b`).
- **LLM:** Ollama, model `gemma4:26b`, `think:false` (direct answers).
- **STT:** `faster-whisper large-v3` on CUDA, driven by a Python server (`grace_whisper_server.py`) spawned by `packages/stt`. Streams newline-JSON transcripts to stdout.
- **TTS:** Kokoro-82M (`grace_kokoro_server.py`, HTTP on `:8765`), voice `af_heart`.
- **Runtime:** Windows 11, RTX 5090 Laptop (24 GB), `py -3.12`, Node 24.

## Monorepo Layout
```text
grace/
  shared/            @grace/shared  — event + domain types (events.ts, types.ts)
  packages/
    core/            @grace/core    — EventBus, GraceCore (orchestrator), PowerManager, memory
    llm/             @grace/llm     — OllamaLLM (the brain: tool loop + autonomous tasks)
    stt/             @grace/stt     — WhisperSTT (spawns the python server)
    tts/             @grace/tts     — KokoroTTS (HTTP client + playback)
    tools/           @grace/tools   — tool framework + built-in tools + TaskRegistry
    overlay/         @grace/overlay — Electron main, HUD UI, context detector
  config/personality.json           — Grace's personality AS DATA (loaded at runtime)
  scripts/                          — Sandbox and scaffold scripts for auto-dev
  grace_whisper_server.py           — STT server
  grace_kokoro_server.py            — TTS server
  start-grace.ps1                   — launcher
```

## The EventBus (The Spine)
Everything talks via a typed singleton `bus` (`@grace/core`).
```text
WhisperSTT --stt:heard {text}--> GraceCore
GraceCore  --llm:thinking {text, history}--> OllamaLLM
OllamaLLM  (multi-step tool loop) --tts:speaking {text}--> KokoroTTS
OllamaLLM  --llm:response {text, spoken}--> GraceCore
KokoroTTS  --tts:done--> GraceCore (resets isProcessing)
```

## The Brain: OllamaLLM
- `SYSTEM_PROMPT` = `loadPersonality()` + `describeEnvironment()` + `describeTools()`.
- **Multi-step Tool Loop:** Loops up to `MAX_STEPS` (8). Emits tools in parallel arrays. Parses JSON tool calls (`format:'json'`).
- **Autonomous Tasks:** `start_mission` plans a backlog (`planBacklog`), then builds through it one item at a time (`buildOneTool`). It survives per-item step caps.
- **Verify-before-done:** After mutative actions (write/move/delete), the loop forces a check before completing.
- **Barge-in / Interrupt:** Global hotkeys (Ctrl+Shift+S, etc.) and short voice commands ("stop", "pause") map to control events, aborting generation and killing TTS mid-sentence.

## UI: Electron HUD Overlay
- **Multi-monitor Support:** Moves to active screen (`config.overlay.displayIndex`).
- **Vignette:** Full-screen transparent overlay showing state via colored borders:
  - Listening: Purple (`rgba(99, 85, 212, 0.20)`)
  - Thinking: Amber (`rgba(245, 158, 11, 0.18)`)
  - Speaking: Green (`rgba(26, 158, 108, 0.18)`)
- **Focus Boxes (`focus_box`)**: Animated glowing boxes (`#7c6af7` border) that fly in from the Grace icon to highlight screen elements Grace is referencing. One vignette window per monitor; the box is routed to whichever display its coordinates fall on.

## Memory Persistence
- `GraceMemory` (`packages/core/src/memory.ts`) manages memory.
- Uses `semanticMemory.ts` with a **ChromaDB** vector backend (`nomic-embed-text`) for deep retrieval, and SQLite (or JSON fallback) for raw state logging.

## Conventions
- **Return `{ error }`** for expected tool failures (e.g., file not found). Don't `throw`.
- Keep results small and serializable. Never hang forever (use `AbortSignal.timeout`).
- Stay 100% local for processing. Public free APIs are fine.
- Commit messages: imperative title + why + Co-Authored-By.
