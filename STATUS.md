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

## In review — `feat/reliability-and-batch-tools` (built + headless-tested; needs Mikkel's live voice test)
- **Multiple tool calls per turn:** model can emit `"tools":[{tool,args},...]`; both loops run them
  in parallel and feed all results back (e.g. `location AND weather` in one turn).
- **Environment awareness:** real home path + Windows username + Danish→English folder map injected
  into the system prompt → no more `C:\Users\mikkel` ENOENT.
- **Verify-before-done:** after any write/edit/move/delete the loops require a re-read/list check;
  the task loop runs tools BEFORE honoring `done:true` so a final action can't be skipped.
- **Prompt clarity:** `edit_file` (not read+overwrite) for partial changes; confirm odd STT before
  heavy actions; per-step instruction sprawl trimmed. `personality.json` v3.
- **Speak timing + deeper loops:** intermediate "On it…" narration no longer mashed onto the final
  answer (only the answer is spoken); MAX_STEPS 5→8, task MAX 14→24 (tokens are free locally).
- **Auto-develop:** `scripts/scaffold-tool.mjs` (build + smoke + auto-revert, real tsc error) **plus a
  Docker sandbox** (`sandbox/` + `scripts/sandbox-tool.mjs`) that builds + RUNS candidate tools with no
  host filesystem / no network — verified a malicious tool can't escape to `C:\Users\mikke`. See
  `docs/auto-develop.md`.

## Optional / opt-in
- `GRACE_TTS_PLAYBACK="server"` — persistent stereo audio player (smoother over BT); off by default.

## Next (see ROADMAP.md)
1. **Live-test + merge** `feat/reliability-and-batch-tools` (voice session: real paths, batched
   calls, verify-before-done, STT-confirm), then land it on main.
2. **`create_tool`** Grace tool — thin wrapper over `sandbox-tool.mjs --promote` (sandbox is built);
   decide the promote policy (auto-promote trivial tools vs review-gate file/network ones). docs/auto-develop.md.
3. take_screenshot + describe_screen (LLaVA vision); filesystem navigation index.
4. better-sqlite3 (P4); scheduler (P2); GitHub remote + push (off-machine backup).
