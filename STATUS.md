# Grace — STATUS

_Updated: 2026-06-04 · RTX 5090 Laptop (24 GB), Win 11 · git: main_

> Backlog + guides: **ROADMAP.md**, **docs/architecture.md**, **docs/adding-tools.md**,
> **docs/working-with-other-ai.md**, **docs/implement-prompt.md** (paste-in agent prompt).

## Working & verified ✅
- GPU I/O loop: Whisper large-v3 (lang `auto`) → gemma4:26b (think:false) → Kokoro `af_heart`.
  Mic = Realtek (Buds4 stay A2DP stereo for output — the audio/HFP issue is solved).
- **Tools** (`@grace/tools`, 17): get_weather, get_location, search_files (BFS), web_search,
  read_file, fetch_url, write_file, edit_file, move_file, delete_file, list_dir, open_path, open_browser,
  clipboard_read/write, task_status, start_background_task. Write/delete/open are gated to the home
  folder (+ a safe-app whitelist for open_path; executables under home are refused). The 5 system
  tools came from parallel subagents (Antigravity), reviewed + security-hardened + merged by Claude.
- **Tool I/O = JSON + Chain-of-Thought:** the model always replies with one JSON object
  `{thought, tool, args, speak, done}` (`format:'json'`, parsed in `registry.ts`) — replaced the old
  fragile narration-regex guards. `edit_file` does surgical `multi_replace`; `read_file` returns the
  whole file by default and flags `truncated` loudly (was silently capping at 40 lines → overwrite
  data-loss, now fixed); `search_files` is BFS (surface hits win); context is 128K (`num_ctx`).
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
1. **Tool-use reliability** (the live-session pain, do first): inject real home path + username into
   the prompt (kills `C:\Users\mikkel` ENOENT); self-verify before `done:true` (re-check line counts
   after writes); steer edits to `edit_file` over read+overwrite; confirm odd STT before heavy actions.
2. **Multiple tool calls per turn** (P1) — cuts latency + re-planning; biggest UX lever.
3. take_screenshot + describe_screen (LLaVA vision); filesystem navigation index.
4. **Auto-develop** (P5): Grace writes → tests in a sandbox → plugs in a tool (one-file-per-tool now
   makes this conflict-free). 5. better-sqlite3 (P4); scheduler (P2); GitHub remote + push.
