# Grace — Known Issues (live voice test, 2026-06-04)

Prioritized with root cause + fix direction. Evidence = the 13:29–14:06 session on
`feat/reliability-and-batch-tools`. **All P0/P1 fixed 2026-06-04 (round 2); P2 addressed.**

> Update: the 3 self-authored tools are kept and committed — `roll_dice` (now supports `sides`),
> `get_current_time`, and `news_fetcher` (**fixed** to use `ctx.callTool`).

## Round 5 — 2026-06-04 (self-development sprint; branch `feat/autonomous-self-dev`)

Built to make Grace ready to develop her own tools in an unattended loop, and to make her
interruptible. All headless-verified; the items below still need a live voice run.

**Shipped (headless-verified):**
- **Hot reload** — self-built tools go live the same turn (dynamic import of the built dist file
  into the live registry; prompt tool-catalog rebuilt per turn). Proven: scaffold in a child
  process → live in another process. **Removes the "active after restart" blocker.**
- **Mission driver** — `start_mission` → plan a backlog → build each item as its own bounded
  sub-task. Fixes the core "hits the cap and goes back to listening" problem: the per-item cap no
  longer ends the run. Planning JSON shape verified against live Ollama (gemma4:e2b).
- **Barge-in** — stop/pause/status hotkeys, killable TTS, abortable generation, voice control
  fast-path, opt-in mic-open-during-speech (`GRACE_VOICE_BARGEIN`).
- **Listen mode** — fixed the phrase bug ("lytte efter" never matched) + widened phrases +
  semantic `enter_listen_mode` (she asks first when unsure).

**Needs live test:**
- A real mission run end-to-end (Docker + 26b): does she keep going for 20+ tools, do hot-loaded
  tools become callable, are risky tools correctly parked as "pending approval"?
- Interrupt feel: does hotkey-stop kill speech instantly mid-sentence? Does voice "stop" land
  between mission steps? With `GRACE_VOICE_BARGEIN=1`, does it land mid-speech without feedback?
- Listen mode: explicit phrase enters immediately; a vague hint makes her ASK first; END phrase
  (or Ctrl+Shift+H) releases and she answers the whole buffered thing.

**Known open / risk:**
- Per-item builder is capped at 8 steps; a very complex tool needing many sandbox-fix cycles may
  be marked failed. Acceptable — it moves on; revisit if many fail live.
- Voice control fast-path is heuristic (anchored, ≤30 chars). A short utterance that happens to
  start with "stop/pause/fortsæt/status" will trigger control. Tune phrases if it misfires.
- Mission planning quality depends on the model; if the backlog is thin, the objective wording
  needs to be more concrete (she'll say so rather than invent).

## Round 4 — 2026-06-04 (speed shelved, listen mode added)

- **Task speed FIXED enough**: batching cut the 18-file task from 5.6 min → ~50s, 50 files → ~94s.
  Mikkel shelved further speed work. **Secondary-brain (concurrent small model) ruled out**: measured
  26b@128K = 22 GB; e4b (11 GB) and e2b (8 GB) both EVICT 26b — no Gemma 4 model co-resides on 24 GB.
- **NEW: listen mode ("hold the floor")** — `GraceCore` buffers speech between a START phrase
  ("let me explain" / "lad mig forklare" / "hør her") and an END phrase ("det var det" / "I'm done" /
  "din tur"), so Mikkel can explain complex things across pauses without Grace replying.
- **Open — batch JSON corruption**: at ~50 calls in one reply, 26b emits malformed JSON — garbled tool
  names (`$\write_file`, `・・write_file`, `write_string`, `else_logic`), stray `pattern`/`lag` keys,
  broken paths (`C:\Users\mikke\:\Users...`, dropped `toolsplit`). Result: a few files end up empty or
  misplaced (the "missed file"). Fix ideas: cap batch size (~10–15/reply) in taskSys; or a dedicated
  `write_files`/`create_files` bulk tool that takes an array, so the model emits ONE small call not 50.
- **Open — cancel timing**: "sæt på pause" often arrives after the (now-fast) task already finished, so
  cancel_task reports "no task running". Works, just races short tasks.

## Round 3 — live test 2026-06-04 PM

**Confirmed working live** ✅: P0 task loop actually did the work (created 18 files, verified, no
fake-done); `create_folder`; `news_fetcher` via `ctx.callTool` (real headlines + topic filter);
**dedup** — asked to "build a news tool" she recognized she already has `news_fetcher` and offered it
instead of duplicating.

**Fixed this round** (headless-verified; behavioural ones need a live run):
- **Said-it-would-but-didn't** (narration without action) — main loop now nudges once when she narrates
  intent ("let me check…") but calls no tool, forcing a real action or an honest "I can't". (`INTENT_RE`)
- **No pause/stop** — new `cancel_task` tool + `TaskRegistry.cancelRequested`; the task loop checks it
  each step and stops. "Grace, stop the task" now works.
- **Tasks painfully slow** (18 files ≈ 5.6 min): the model re-emitted the full file content every step
  AND it was echoed back into context. Task replies are now stored COMPACT, and taskSys tells her to
  BATCH many similar ops into one reply (`tools[]`). Should cut big tasks from minutes toward seconds.
- **Don't clobber a running task** — main loop refuses to start a 2nd background task while one runs.

**Still open (next):**
- **Latency** — each task step is still one LLM call (~10–15s); batching helps but per-call cost
  remains. Consider a lighter/faster model for mechanical steps, or a real "for-each" primitive.
- **Full barge-in / concurrency** — while a task runs, the main loop still answers in parallel, so two
  voices interleave; `cancel_task` is the escape hatch but true pause/resume is ROADMAP P2.
- **Comprehension** — the first split put the WHOLE list in every file: her own task description said
  "same content as the original". Self-corrected when told. Better task-description discipline needed.
- **Deferred cross-boundary actions** — "open a file when the task is done" (said in the main loop
  while a task ran) was dropped; she needed reminding. No queue for post-task actions yet.
- **news_fetcher quality** — returns mostly site homepages, not specific articles; could `fetch_url`
  the top hit for a real snippet.

## ✅ Fixed (2026-06-04, round 2) — verified headless except P0 (needs live test)

- **P0 task loop:** task mode forbids `task_status`/`start_background_task` (hard corrective), runs only
  real tools, and a *did-real-work* guard means she can't claim "done" without acting — if nothing ran
  she says so honestly. (`OllamaLLM.ts runBackgroundTask`) — **re-test live.**
- **P1a confirm gate:** `confirm:true` is ignored unless the tool was already surfaced for approval
  (`pendingRisky` set); first-call promotion of file/network tools is blocked. ✅ verified.
- **P1b dedup:** create_tool description + personality rule tell her to check existing tools first.
- **P1c inter-tool calls:** every `run(args, ctx)` gets `ctx.callTool`; `news_fetcher` rewritten to use it. ✅
- **P1d update:** create_tool/sandbox `--force` on promote → a sandbox-validated tool can be updated. ✅
- **P2:** write/edit/move/delete refuse Grace's own source (`packages|sandbox|scripts|shared`) → use
  create_tool. Added `create_folder`; write_file auto-creates parents. ✅

Residual (acceptable, revisit if seen): a model could surface+confirm a risky tool in the SAME turn
(STOP message + pending-set make it unlikely); a real-build failure after a sandbox-passed UPDATE could
lose the old tool (sandbox parity makes this rare).

---

## P0 — Background tasks DO NOTHING but poll, then falsely claim success
**Symptom:** "create a `Tools` folder + one .txt per tool" → 65–88 s of the task loop calling ONLY
`task_status` (and re-calling `start_background_task`), never `write_file`/`list_dir`. Ends with
"All done! …verified" but nothing was created. Happened 3× (13:46, 13:48, 13:51). User: "der er ikke nogen filer."

**Root cause:** inside `runBackgroundTask` the model thinks a *separate* task is running and polls it.
It (a) re-calls `start_background_task` (my filter drops it → wasted step) and (b) spams `task_status`,
which reports on *itself* → always "still working" → loops to MAX → false `done`. It never grasps that
IT is the worker. Verify-before-done didn't catch it because it "verified" without having acted.

**Fix direction:**
- In `taskSys`, state hard: "You ARE the task. Do each step yourself with real tools (write_file,
  list_dir…). NEVER call start_background_task or task_status here." 
- Make `task_status` + `start_background_task` no-ops/unavailable inside the task loop.
- Verify-before-done must check the ACTUAL artifact exists (list_dir/read_file) before allowing done:true.
- Bias toward doing multi-step file work in the MAIN loop (its budget is now 8) and reserve
  `start_background_task` for genuinely long research — most of these tasks shouldn't background at all.

## P1a — create_tool confirm gate is bypassable (model sets confirm:true itself)
**Symptom:** Grace built get_current_time, roll_dice AND news_fetcher (network!) each with `"confirm": true`
set by the model — never asked. User: "Var det ikke meningen, at du skal spørge mig?"
**Root cause:** `confirm` is a model-filled arg, so the model just sets it. The gate is meaningless.
**Fix direction:** confirm must mean a REAL prior user approval. (a) track pending risky tools in a
module Set — first risky call returns needs_confirmation + records the name; promote only if already
pending; (b) prompt rule: "NEVER set confirm:true unless Mikkel approved in a PREVIOUS turn"; (c) ideally
only the main loop (seeing the user's "yes") passes confirm. Do (a)+(b).

## P1b — create_tool must check existing tools first (explicit user request)
**Symptom:** builds tools without checking for near-duplicates (dice/coin/RNG risk).
**Fix:** before creating, compare name + purpose against `listTools()`; if similar exists, refuse/ask
rather than create a duplicate. Inject the current tool list into the create flow or check inside create_tool.

## P1c — Tools can't call other tools → composed tools are born broken
**Symptom:** news_fetcher tried `globalThis.callTool`, `import {web_search}`, `this.callTool` — none exist
→ runtime "globalThis.callTool is not a function" → returns "No recent news." It STILL passed the sandbox
(swallowed its own error, returned a normal string).
**Fix direction:** (a) give `run(args)` a way to call other tools — pass a context `{ callTool }` as a 2nd
arg (or export a callable), and document it in adding-tools.md + create_tool's description; (b) sandbox
smoke should surface internal throws (console.error) so error-swallowing tools don't pass.

## P1d — create_tool can't UPDATE an existing tool
**Symptom:** updating roll_dice → "passed sandbox but failed to promote: already exists (use --force)".
Grace worked around it by editing the repo source directly with edit_file (sandbox bypass).
**Fix:** when the tool already exists, promote as an update (pass `--force` to scaffold-tool after a clean
sandbox pass).

## P2
- **edit_file can modify Grace's own repo source** (she edited `packages/tools/src/tools/roll_dice.ts`
  live, bypassing the sandbox). Decide: block edits under the grace repo, or route them via create_tool.
- **get_weather flaky** (timeout + HTTP 502 ×3 at 13:39). Also the model put a fabricated "11 degrees and
  cloudy" in `speak` before the tool ran (anti-fabrication slip — masked by the speak-timing fix). Consider
  a fallback weather source and a prompt note: never state values in speak before the tool returns.
- **Latency:** single turns 17–40 s, one 69 s, first-after-restart ~20 s. User accepts thorough cycles;
  the real waste was the P0 polling loops (65–88 s doing nothing) — fixed by P0.

---

## What WORKED (keep, don't regress)
- ✅ Paths/username correct everywhere (`C:\Users\mikke`) — env block killed the ENOENT class.
- ✅ STT-confirm: "Hej, hænden over dine erhverv" → she asked instead of acting.
- ✅ Speak timing: no goal+answer mash; clean single answers.
- ✅ edit_file + read-back verify across ~8 edits to tools_list.txt — no data loss.
- ✅ create_tool happy path: dice tool → sandbox → promoted → after restart roll_dice (6 & 20 sides) worked.
- ✅ Self-correcting TS build errors (news_fetcher fixed across retries via the surfaced error).

---

## Deferred from the 2026-07-20 adversarial review (see docs/12-REVIEW-AND-HARDENING.md)
- **Concurrent-turn shared OllamaLLM state** — a fire-and-forget mission runs while GraceCore is
  "listening," so a barge-in turn shares instance fields (`currentAbort`, `lastToolContext`). Fix =
  per-run AbortController / cancel token; do it with a live mic to test barge-in, not blind.
- **Chroma /api/v1 vs v2** — heartbeat accepts a v2-only server but ops hit /api/v1, so recall can
  silently degrade to local-only while telemetry says "chroma." Pin the version against a live Chroma.
- **MCP spawns arbitrary executables / SSRF** — mcp_add_server+mcp_call let model-driven input run any
  local exe / reach any host. shell:false stops arg injection; gate NEW exe/host behind confirmation or
  an allowlist (product decision).
- **Vault default key is machine-derived** (guessable) when GRACE_VAULT_KEY is unset — salt is now
  random, but set GRACE_VAULT_KEY for real at-rest security.
