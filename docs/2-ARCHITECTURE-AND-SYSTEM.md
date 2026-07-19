# Grace — Architecture & System

Read this before implementing anything. It explains the layout, the data flow, and the conventions.

## Stack
- **Electron** app (`packages/overlay`) hosts the main process and HUD UI.
- **TypeScript monorepo** (npm workspaces + TS project references, build via `tsc -b`).
- **LLM:** Ollama, model `gemma4:26b` (multimodal — the same model does vision via `box_2d`), `think:false` (direct answers).
- **STT:** OpenVINO Whisper `large-v3` fp16 on the **Intel Arc 140T iGPU** (device `GPU.0`), Danish forced (`GRACE_WHISPER_LANG=da`). Driven by a Python server (`grace_whisper_server.py --backend openvino`) spawned by `packages/stt`, streaming newline-JSON transcripts to stdout. `faster-whisper` on CUDA is a fallback backend. A deterministic post-ASR correction pass (`config/stt-corrections.json`, `sttCorrections.ts`) fixes reliably mis-heard names.
- **TTS:** Kokoro-82M (`grace_kokoro_server.py`, HTTP on `:8765`), English voice `af_heart`. A Danish TTS backend is planned (routes via `GRACE_TTS_DA_URL`).
- **Retrieval:** `web_search` is SearXNG-first (local `docker/searxng`, `GRACE_SEARCH_URL`) with a DuckDuckGo fallback; `fetch_url` does readability extraction; a `research` tool grounds factual answers in sources (`packages/tools/src/lib/web.ts`).
- **Language mode:** Danish⇄English switch (`settings.ts`) driven by `set_language` / voice.
- **Runtime:** Windows 11 native (not WSL2), RTX 5090 Laptop (24 GB), `py -3.12`, Node 24.

## Monorepo Layout
```text
grace/
  shared/            @grace/shared  — event + domain types (events.ts, types.ts)
  packages/
    core/            @grace/core    — EventBus, GraceCore (orchestrator), PowerManager,
                                       semanticMemory, settings (language mode), fsIndex, sttCorrections
    llm/             @grace/llm     — OllamaLLM (the brain: tool loop + autonomous tasks)
    stt/             @grace/stt     — WhisperSTT (spawns the python server)
    tts/             @grace/tts     — KokoroTTS (HTTP client + playback)
    tools/           @grace/tools   — tool framework + built-in tools + TaskRegistry
    overlay/         @grace/overlay — Electron main, HUD UI, context detector
  config/personality.json           — Grace's personality AS DATA (loaded at runtime)
  config/index-roots.json           — filesystem-index roots (find_file / *_indexed_folder)
  config/stt-corrections.json       — deterministic post-ASR name fixes
  docker/searxng, docker/chroma     — local SearXNG (search) + ChromaDB (vector memory)
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
- A single shared `graceMemory` singleton (`packages/core/src/semanticMemory.ts`; `memory.ts` is just a re-export shim) owns all memory.
- **ChromaDB** vector backend (pinned `chromadb/chroma:0.4.24`, v1 REST API, embeddings via `nomic-embed-text`) for deep semantic retrieval, auto-started from `docker/chroma` when reachable. It is nice-to-have: if Docker/Chroma is down, recall degrades gracefully to a local keyword journal.
- Raw turns log to SQLite (`node:sqlite` in scripts / `better-sqlite3` in Electron) with a JSON fallback.
- Conversation history is **token-budgeted with a rolling summary** (assembled by GraceCore), and the LLM runs at `num_ctx` 131072.
- Planned: move embeddings to a Danish-strong e5 model off the RTX — see `docs/6-MODEL-UPGRADES.md`.

## Other Local Subsystems
- **Language mode** (`settings.ts`): file-backed Danish⇄English switch via `set_language` / voice. Consumers pull the current value live — OllamaLLM (reply language), KokoroTTS (voice), STT (model). Default from `GRACE_DEFAULT_LANGUAGE`.
- **Filesystem index** (`fsIndex.ts` + `config/index-roots.json`): fuzzy name→path index over configurable roots, powering `find_file` and the `*_indexed_folder` tools.
- **STT corrections** (`sttCorrections.ts` + `config/stt-corrections.json`): deterministic whole-word post-ASR fixes, curated by voice via `add_stt_correction`.

## Conventions
- **Return `{ error }`** for expected tool failures (e.g., file not found). Don't `throw`.
- Keep results small and serializable. Never hang forever (use `AbortSignal.timeout`).
- Stay 100% local for processing. Public free APIs are fine.
- Commit messages: imperative title + why + Co-Authored-By.
