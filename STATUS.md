# Grace — STATUS

_Updated: 2026-06-03 · RTX 5090 Laptop (24 GB), 64 GB RAM, Win 11 · git: main_

## Goal
Foundational structure usable for real, then build on top → eventually self-expanding.

## Git
Commits on `main`: `2a5f35e` foundation · `510d392` multi-step tools · `be0359d` status ·
`3248c9b` stateful navigation · `4b33cc2` tools→@grace/tools. Working tree clean. No remote yet.

## Working & verified ✅
- I/O loop: Whisper `large-v3` (GPU) → `gemma4:26b` (think:false) → Kokoro TTS (`af_heart`, GPU).
  Speak Danish → reply English. Cross-session memory (JSON; node:sqlite absent in Electron).
- **Tools now a real package**: `@grace/tools` (composite; llm builds via `tsc -b`). Built-ins:
  get_weather, get_location, search_files (files+folders), web_search (real URLs).
- **Multi-step agentic loop** (≤5 steps): chains tool calls, self-corrects (overførsler→Downloads),
  nudges instead of going silent.
- **Stateful navigation (new, verified)**: `lastToolContext` carries the previous tool result's
  full paths into the next turn, so "go into that folder" resolves the real path instead of
  restarting from home. Verified: Downloads → "go into hacker-demo" → navigated the nested project.
- **Act, don't narrate (new)**: "let me find…" promises are rejected as final; loop forces the tool call.
- `<SKIP>` tightened (greetings/questions/requests never skipped).

## Known issues (next)
- **STT mangles English names** in Danish context (Claude→"plot"/"klart"). Recoverable via
  conversation, but rough. Experiment: set `GRACE_WHISPER_LANG="auto"` in start-grace.ps1 (may
  trade some Danish accuracy). Or add common terms to the Whisper initial_prompt.
- **Audio cutout** — first sentence of a multi-sentence reply occasionally dropped (BT/per-clip
  spawn). Real fix = **persistent audio player** in KokoroTTS (replaces per-clip PowerShell spawn);
  also smooths the last latency. Top TTS task.
- Bluetooth Buds4 mic forces HFP mono output; use `GRACE_MIC_NAME="Realtek"` for stereo.
- Startup recall can surface junk (filter <20 chars). GPS vs IP location. Calendar (OAuth).

## Run
`cd grace ; .\start-grace.ps1`  → try: "kig i min overførsler-mappe", then "gå ind i <folder>".

## Next session
1. Persistent audio player (cutout + smoothness). 2. STT tuning for names. 3. More tools (GPS/calendar)
   + multi-tool-per-turn. 4. GitHub remote + push.
