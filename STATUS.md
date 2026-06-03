# Grace — STATUS

_Updated: 2026-06-03 · RTX 5090 Laptop (24 GB), Win 11 · git: main_

> Backlog + guides: **ROADMAP.md**, **docs/architecture.md**, **docs/adding-tools.md**,
> **docs/working-with-other-ai.md**, **docs/implement-prompt.md** (paste-in agent prompt).

## Working & verified ✅
- GPU I/O loop: Whisper large-v3 (lang `auto`) → gemma4:26b (think:false) → Kokoro `af_heart`.
  Mic = Realtek (Buds4 stay A2DP stereo for output — the audio/HFP issue is solved).
- **Tools** (`@grace/tools`): get_weather, get_location, **search_files** (fuzzy), web_search,
  read_file, fetch_url, **write_file** + **move_file** (gated to home; relative paths resolve under
  home — fixed a bug where files landed in the app dir), task_status, start_background_task.
- **Multi-step tool loop** (self-correcting, stateful navigation, acts-not-narrates) and
  **autonomous background tasks** (plan→execute→verify→report). Both verified headless.
- Personality-as-data + anti-fabrication + **capability honesty** (no claiming tools she lacks).
- **Logging:** every console line is timestamped `[HH:MM:SS.mmm]`; the tool loop logs each tool
  result + duration + total reply time; autonomous tasks log the plan + every step + total time.
- Single-clip TTS; **playWav timeout 60s→600s** (long replies were SIGTERM-killed at 60s).
- Cross-session memory (JSON; node:sqlite absent in Electron), git history (12+ commits).

## Optional / opt-in
- `GRACE_TTS_PLAYBACK="server"` — persistent stereo audio player (smoother over BT); off by default.

## Next (see ROADMAP.md)
1. **Tools** (great for parallel work via other AIs): list_dir, clipboard, open_path, app_context,
   take_screenshot + describe_screen (LLaVA); **multiple tool calls per turn** (P1).
2. Autonomous task results = short spoken summary + full detail to a file (P7).
3. better-sqlite3 (P4); scheduler → self-expansion (P2/P5); STT vocabulary biasing (P3).
4. GitHub remote + push (off-machine backup).
