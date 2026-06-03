# Grace — STATUS

_Updated: 2026-06-03 · RTX 5090 Laptop (24 GB), Win 11 · git: main_

> Full backlog + guides: **ROADMAP.md**, **docs/architecture.md**, **docs/adding-tools.md**,
> **docs/working-with-other-ai.md**.

## Working & verified ✅
- GPU I/O loop: Whisper large-v3 → gemma4:26b (think:false) → Kokoro `af_heart`. Danish in, English out.
- **Tools** (`@grace/tools`): get_weather, get_location, search_files (files+folders, stateful
  navigation), web_search, **read_file**, **fetch_url** (full page text), task_status, start_background_task.
- **Multi-step tool loop**: self-corrects (overførsler→Downloads), keeps its place across turns,
  acts instead of narrating. **Autonomous background tasks** (plan→execute→verify→report) — verified.
- Personality-as-data, anti-fabrication, single-clip TTS, fresh-session context, memory (JSON), git.

## Needs YOUR live test (couldn't verify headless)
- **Audio player (opt-in)**: set `$env:GRACE_TTS_PLAYBACK = "server"` in start-grace.ps1 (line is
  there, commented). Server now plays via a persistent stream instead of per-clip PowerShell —
  should stop the dropouts/"switching". Re-comment to revert if worse.
- **Autonomous tasks live**: try "find X, dig through it and report back" → she should say she'll
  get back to you, work in the background, then announce the result. Ask "how far are you?" mid-task.
- **Bluetooth audio**: the "switching" is the Buds4 *mic* forcing HFP mono. For stereo, use
  `GRACE_MIC_NAME="Realtek"` (laptop mic) so the earbuds stay A2DP for output.

## This session's commits
`fetch_url` · autonomous task system · roadmap+guides · opt-in audio player.

## Next (see ROADMAP.md for full detail + how-to)
1. **Persistent audio** — confirm `GRACE_TTS_PLAYBACK=server` feels better (P0).
2. **Tools**: list_dir, write_file (gated), clipboard, open_path, app_context, screenshot+vision;
   **multiple tool calls per turn** (P1). Headless-testable → good to hand to Antigravity/Copilot.
3. STT `lang="auto"` experiment (P3); better-sqlite3 (P4); scheduler → self-expansion (P2/P5).
