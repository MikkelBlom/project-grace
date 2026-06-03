# Grace — Architecture (for humans and AI assistants)

Read this before implementing anything. It explains the layout, the data flow, and the
conventions so a change lands cleanly.

## Stack
- **Electron** app (`packages/overlay`) hosts everything in its main process.
- **TypeScript monorepo** (npm workspaces + TS project references, build via `tsc -b`).
- **LLM:** Ollama, model `gemma4:26b`, `think:false` (it's a thinking model; we want direct answers).
- **STT:** `faster-whisper large-v3` on CUDA, driven by a Python server (`grace_whisper_server.py`)
  spawned by `packages/stt`. Streams newline-JSON transcripts to stdout.
- **TTS:** Kokoro-82M (`grace_kokoro_server.py`, HTTP on `:8765`), voice `af_heart`, on GPU.
- **Runtime:** Windows 11, RTX 5090 Laptop (24 GB), `py -3.12`, Node 24.

## Monorepo layout
```
grace/
  shared/            @grace/shared  — event + domain types (events.ts, types.ts)
  packages/
    core/            @grace/core    — EventBus, GraceCore (orchestrator), PowerManager, memory
    llm/             @grace/llm     — OllamaLLM (the brain: tool loop + autonomous tasks), MockLLM
    stt/             @grace/stt     — WhisperSTT (spawns the python server), MockSTT
    tts/             @grace/tts     — KokoroTTS (HTTP client + playback), MockTTS
    tools/           @grace/tools   — tool framework + built-in tools + TaskRegistry
    overlay/         @grace/overlay — Electron main, windows, tray, context detector
  config/personality.json           — Grace's personality AS DATA (loaded at runtime by OllamaLLM)
  grace_whisper_server.py            — STT server (mic → VAD → whisper → JSON)
  grace_kokoro_server.py             — TTS server (text → WAV) on :8765
  start-grace.ps1                    — launcher (sets env, starts Kokoro, runs the app)
  data/                              — runtime memory (gitignored)
```

## The EventBus (the spine)
Everything talks via a typed singleton `bus` (`@grace/core`). Events are declared in
`shared/src/events.ts`. The conversation flow:

```
WhisperSTT --stt:heard {text}--> GraceCore
GraceCore  --llm:thinking {text, history}--> OllamaLLM
OllamaLLM  (multi-step tool loop) --tts:speaking {text}--> KokoroTTS
OllamaLLM  --llm:response {text, spoken}--> GraceCore   (history + overlay; no re-speak if spoken)
KokoroTTS  --tts:done--> GraceCore (resets isProcessing, back to listening)
```
- `GraceCore` (`packages/core/src/GraceCore.ts`) is the orchestrator: routes STT→LLM→TTS,
  handles modes (discreet/field-notes/paused), restores memory, logs turns, emits the greeting.
- Providers are swappable via env (`GRACE_LLM_PROVIDER` etc.); `packages/overlay/src/main.ts`
  picks `OllamaLLM` vs `MockLLM` and wires services.

## The brain: `packages/llm/src/OllamaLLM.ts`
Key pieces (don't bypass them):
- `SYSTEM_PROMPT` = `loadPersonality()` (from `config/personality.json`) + `describeTools()`.
- `complete(messages, systemPrompt?)` — one non-streaming chat call (`think:false`). Pass a custom
  system prompt for special modes.
- **`llm:thinking` handler = the multi-step tool loop:**
  builds `work` (history + a `lastToolContext` note for navigation + the user turn), then loops up
  to `MAX_STEPS`: `complete` → `parseToolCall` → if tool, run it and feed the result back; if prose,
  that's the answer. Guards: rejects "let me find…" narration (forces the tool), handles `<SKIP>`,
  intercepts `start_background_task`. Speaks the final answer as ONE clip.
- **`runBackgroundTask(description)`** — autonomous: plan → execute (tool loop with verification,
  task-mode system prompt, no `<SKIP>`) → `TaskRegistry.finish` → announce via the bus.

## Tools: `packages/tools/src/`
- `registry.ts` — `ToolSpec { name, description, params, run(args) }`, `registerTool`, `describeTools`
  (injected into the system prompt), `parseToolCall` (extracts the first balanced JSON object from a reply),
  `runTool(name, args)`, `fetchJson` helper, `TaskRegistry`. **See `docs/adding-tools.md`.**
- `tools/*.ts` — one file per tool, each self-registers via `registerTool()` at import time.
- `index.ts` — re-exports the public API from `registry.ts` and loads all tool files.
- `TaskRegistry` — in-memory status for the running background task (`task_status` reads it).

## Persistence: `packages/core/src/memory.ts`
- `GraceMemory` uses Node `node:sqlite` if available, else a JSON file (`data/`). Stores turns;
  restores the last few on boot. **To upgrade to real SQLite in Electron:** add `better-sqlite3`
  + `electron-rebuild` and implement the `Backend` interface (the seam is already there).

## Build & run
- Build: `npm run build` (root) → `tsc -b` per package. Must be **exit 0**.
- Run the app: `.\start-grace.ps1` (needs Ollama running + `gemma4:26b` pulled).
- Headless test a tool/loop: `node` an ESM script that imports `./packages/tools/dist/index.js`
  and calls `runTool(...)` (see `docs/adding-tools.md`). Ollama must be running on `:11434`.

## Conventions
- TypeScript, `camelCase`/`PascalCase`, ESM (`"type":"module"`, import paths end in `.js`).
- Tools: return `{ ...data }` or `{ error }` for *expected* failures (don't throw); keep results
  small + JSON-serializable; never block forever (use `AbortSignal.timeout`).
- Keep it **100% local** for models/processing. Tools may call free no-key public APIs.
- Commit messages: imperative title + why; end with the Co-Authored-By trailer used in history.
- Don't break the build; test before committing; small focused commits.
