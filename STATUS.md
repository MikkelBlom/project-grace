# Grace — STATUS

_Updated: 2026-06-03 · RTX 5090 Laptop (24 GB), 64 GB RAM, Win 11_

## Goal
Foundational structure usable for real, then build on top → eventually self-expanding.

## Working & verified ✅
- I/O loop: mic → Whisper `large-v3` (GPU) → `gemma4:26b` (think:false, streaming) → Kokoro TTS.
- Voice = Kokoro **female English** (`af_heart`); speak **Danish** → reply **English**.
- Personality as data (`config/personality.json`, runtime-editable). Selective `<SKIP>`,
  name-mishearing recovery, **anti-fabrication** (no fake data/sources/dates, no "I'll try again").
- Tools (`packages/llm/src/tools.ts`): `get_weather`, `get_location`, `search_files`, `web_search`
  (DDG HTML, real URLs). One tool per turn.
- **Persistence (new, verified headless)**: `packages/core/src/memory.ts` — `node:sqlite` with JSON
  fallback, stored in `grace/data/`. GraceCore restores last 8 turns on boot + logs every turn.
- **Terminal logging**: Grace's replies now print as `[Grace] 💬 …` (and `🤐` on skip).
- **Startup greeting**: main.ts speaks a greeting ~3s after boot; recalls previous session's last
  topic via `getStartupGreeting()`. (Spoken-on-boot timing needs live confirmation.)

## Mic / audio notes
- `GRACE_MIC_NAME` in start-grace.ps1 chooses mic. **Bluetooth caveat**: using Buds4 as MIC forces
  HFP mono (one ear). Use `"Realtek"` to keep Buds4 stereo for output. Default currently `"Buds4"`.

## Known / deferred
- **Latency** "clunky/not smooth" — TTS pipeline (Kokoro CPU + PowerShell spawn per clip). Real fix =
  GPU Kokoro (torch cu128) or a persistent audio player. Deferred (user: minor).
- Electron's bundled Node may lack `node:sqlite` → auto JSON fallback (still persists).
- search_files depth limits; GPS location (vs IP); multi-turn agency ("retry"); calendar (OAuth).
- `git init` still pending. Tools NOT yet promoted to `packages/tools` (optional).

## Run
`cd grace ; .\start-grace.ps1`  → she should greet you on boot and remember across restarts.

## Next candidates
1. Smooth TTS latency (GPU Kokoro / persistent player).
2. `git init` (overdue — lots uncommitted) + promote tools → `packages/tools`.
3. Session-summary on close (better "unfinished" recall than last-user-message).
