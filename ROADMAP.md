# Project Grace — Roadmap

A 100% **local**, voice-driven AI assistant: speak (Danish or English) → Whisper STT (GPU)
→ `gemma4:26b` via Ollama → Kokoro TTS (GPU, female English), with a tool system, memory,
and autonomous task execution. Everything runs on the machine; tools may reach the internet
for info (weather/web) the way any assistant does.

> **Read first:** `docs/architecture.md` (how the system fits together),
> `docs/adding-tools.md` (how to add capabilities), `docs/working-with-other-ai.md`
> (how to implement items below in parallel and have them validated).

---

## ✅ Done (on `main`)
- I/O loop on GPU: Whisper large-v3 → gemma4:26b (think:false) → Kokoro `af_heart`.
- Personality as editable data (`config/personality.json`), selective `<SKIP>`, anti-fabrication.
- **Tools** (`@grace/tools`): `get_weather`, `get_location`, `search_files` (files+folders),
  `web_search`, `read_file`, `fetch_url`, plus `task_status` / `start_background_task`.
- **Multi-step tool loop** with self-correction (Danish→English folder names) and stateful
  navigation ("go into that folder" keeps its place).
- **Autonomous background tasks**: plan → execute → verify → report ("I'll get back to you").
- Cross-session memory (JSON; node:sqlite absent in Electron), startup greeting, git history.

---

## 🔝 Priority backlog

### P0 — Audio quality (needs the user's ears; can't be verified headless)
- **Persistent audio player.** Today TTS plays each reply via a fresh PowerShell `SoundPlayer`
  process (`packages/tts/src/KokoroTTS.ts → playWav`). Over Bluetooth this causes dropouts and
  "switching" sounds. **Fix options (pick one):**
  1. **Server-side playback (recommended):** add a `/speak` endpoint to `grace_kokoro_server.py`
     that synthesizes **and plays** via a single long-lived `sounddevice.OutputStream` (PortAudio),
     so the audio device stays open. `KokoroTTS.ts` POSTs text to `/speak` instead of fetching a
     WAV + spawning PowerShell. Keeps one stable audio path → no per-clip re-acquire.
  2. Node-side persistent player (e.g. `speaker` npm package fed PCM) — avoids PowerShell but adds
     a native dep.
- **Bluetooth mono caveat (document, not a bug):** using the Buds4 as the *mic* forces Windows
  into HFP (mono, one ear). Real fix = use a non-BT mic for input (`GRACE_MIC_NAME="Realtek"`) so
  the earbuds stay A2DP stereo for output. This is the "sound switches" cause.

### P1 — Tools (the toolbox; see `docs/adding-tools.md` for the wishlist with specs)
- `list_dir`, `run_command` (sandboxed allowlist), `open_path` (launch file/folder/app),
  `clipboard_read`/`clipboard_write`, `take_screenshot` (+ vision via LLaVA), `create_reminder`,
  `app_context` (what window is focused), `system_volume`/`media_control`, `write_file`/`append_file`.
- **Multiple tool calls per turn** — let the model emit a list `[ {tool,args}, ... ]` so
  "location AND weather" run together. Parse + run in parallel, feed all results back.

### P2 — Autonomy & agency
- **Scheduled / recurring tasks** (e.g. "every morning summarise my calendar"): a real job queue.
  Original vision = Redis + BullMQ; lighter local option = a JSON-backed scheduler + setInterval.
- **Barge-in / interruption:** let the user talk over Grace; pause TTS, capture, resume or redirect.
- **Better planning:** for big tasks, an explicit plan object with checkable steps + progress %.

### P3 — STT accuracy
- `GRACE_WHISPER_LANG="auto"` experiment for mixed DA/EN (English names like "Claude" → "plot").
- Bias `initial_prompt` with a small project vocabulary (names, tech terms).
- Optional **push-to-talk** / **wake word** ("Hey Grace") to cut accidental triggers and echo.

### P4 — Infrastructure
- **Real SQLite** via `better-sqlite3` + `electron-rebuild` (memory.ts already falls back to JSON;
  swap the backend when ready). Enables richer queries (search history, per-topic recall).
- **Docker sandbox** for running generated code safely (Phase 5/6 of the original vision).
- **vLLM** path (WSL2) for higher LLM throughput if needed.

### P5 — Self-expansion (the original north star)
- **Grace writes her own tools:** generate a tool definition → test it in the sandbox →
  `auto_git_commit` → hot-load into `@grace/tools`. Build on the existing tool framework +
  the autonomous task loop + a Docker sandbox.

### P6 — Remote access
- WhatsApp (Meta Cloud API — heavier) or Telegram (trivial Bot API) bridge to talk to Grace remotely.

### P7 — Overlay / debug view
- The Electron debug overlay (`DebugWindow`, IPC `graceDebug` + `debug:event`) is the dev
  "magnifying glass". Make it MORE INFORMATIVE but keep it lightweight (Mikkel uses the console
  more): a status ticker + a simplified live log stream + current `task_status`. A standalone
  window later is fine — but do NOT build a heavy enterprise dashboard (decided with Mikkel).
- Show `task_status` progress in the overlay; "speaking" state on first audio; focus boxes;
  multi-monitor follow; vignette states (already scaffolded in `packages/overlay`).
- **Autonomous task results:** speak a SHORT summary and write the full detail to a file / the
  overlay, instead of a multi-minute spoken monologue.

---

## Suggested order for parallel work
1. **P0 persistent audio** (one focused PR; needs the user to listen).
2. **P1 `list_dir`, `write_file`, `clipboard`, multiple-tools-per-turn** (easy, high value, headless-testable).
3. **P1 `take_screenshot` + LLaVA vision** (lets Grace *see* the screen — big capability).
4. **P3 STT auto-lang** (one-line experiment).
5. **P4 better-sqlite3**, then **P2 scheduler**, then **P5 self-expansion**.
