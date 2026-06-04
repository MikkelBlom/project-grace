# Grace — STATUS

_Updated: 2026-06-04 · RTX 5090 Laptop (24 GB), Win 11 · git: main_

> Backlog + guides: **ROADMAP.md**, **docs/architecture.md**, **docs/adding-tools.md**,
> **docs/working-with-other-ai.md**, **docs/implement-prompt.md** (paste-in agent prompt).
> **docs/known-issues.md** — live-test rounds 1–3. P0 confirmed working live; round-3 fixes (cancel_task, task speed, narration guard) need a re-test.

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

## In review — `feat/autonomous-self-dev` (built + headless-tested; needs Mikkel's live voice test)
Branches off `feat/reliability-and-batch-tools`. The sprint to make Grace ready to develop
herself in a loop, and to make her interruptible.
- **Hot reload** — `create_tool` now dynamic-imports the freshly-built `dist/tools/<name>.js`
  after a successful promote, so a self-built tool is **live the same turn, no restart**. The
  system-prompt tool catalog is rebuilt every turn (`currentSystemPrompt()`), so she actually
  knows the new tool exists. Safeguards unchanged (pure-compute auto, file/network gated).
  *Verified headless* (scaffold a tool in a child process → live in another process' registry).
- **Autonomous mission driver** — new `start_mission` tool + `runMission`: she plans a backlog
  (`planBacklog`, may web_search), then builds through it one item at a time (`buildOneTool` →
  `create_tool`, with sandbox-fix retries). Each item is its own bounded sub-task, so a per-item
  step cap never ends the mission — **this is what stops her falling back to listening at the cap.**
  Tallies built / pending-approval / failed; risky tools that pass the sandbox are recorded as
  "pending your approval" (not promoted unattended). Planning JSON shape verified vs live Ollama.
- **Barge-in / interrupt** — global hotkeys: **Ctrl+Shift+S** stop everything, **Ctrl+Shift+Space**
  pause/resume, **Ctrl+Shift+.** spoken status, **Ctrl+Shift+H** toggle listen mode. TTS is now
  killable mid-sentence (spawned child, SIGTERM + queue flush); in-flight generation aborts via
  AbortController. Voice fast-path: short "stop/pause/fortsæt/status" map to control events even
  mid-work. Optional **GRACE_VOICE_BARGEIN=1** keeps the mic open during her speech (safe with
  earbud output + laptop mic — recommended for Mikkel's setup).
- **Listen mode fixed + semantic** — the old phrase list never matched "lytte efter" (the bug).
  Widened phrases (incl. "slå lyttelapperne ud"); plus a semantic path: `enter_listen_mode` lets
  her decide to hold the floor and **ask first** ("Vil du have jeg bare lytter, til du er klar?").

> **Live-test focus for this branch:** (1) say the big objective → she calls start_mission, plans,
> and builds 20+ tools in a loop without stopping at a cap; (2) interrupt her by hotkey AND by voice
> while she works/speaks; (3) "lytte efter" / "slå lyttelapperne ud" enters listen mode, and a vague
> hint makes her ASK first; (4) a hot-loaded tool is callable in the same session. Needs Docker + 26b.

## Optional / opt-in
- `GRACE_TTS_PLAYBACK="server"` — persistent stereo audio player (smoother over BT); off by default.
- `GRACE_VOICE_BARGEIN=1` — keep mic open during Grace's speech so a spoken "stop" interrupts her
  mid-sentence. Only safe with in-ear output (earbuds) + a separate mic; off by default.

## Next (see ROADMAP.md)
1. **Live-test + merge** `feat/reliability-and-batch-tools` (voice session: real paths, batched
   calls, verify-before-done, STT-confirm), then land it on main.
2. **`create_tool` ✅ built** — Grace authors a tool → sandbox validates → pure-compute auto-promotes,
   file/network tools gate for confirmation (`confirm:true`). Verified headless. Next: hot-load without
   restart (today a new tool is live after the next app start); `auto_git_commit` after a tool goes green.
3. take_screenshot + describe_screen (LLaVA vision); filesystem navigation index.
4. better-sqlite3 (P4); scheduler (P2); GitHub remote + push (off-machine backup).
