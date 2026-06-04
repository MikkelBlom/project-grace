# Grace — Known Issues (live voice test, 2026-06-04)

Prioritized with root cause + fix direction. Evidence = the 13:29–14:06 session on
`feat/reliability-and-batch-tools`. Fix next session.

> Note: during the test Grace self-authored 3 tools that are now UNTRACKED in the working
> tree: `roll_dice.ts` (good), `get_current_time.ts` (ok), `news_fetcher.ts` (**broken** — see P1c).
> Triage these before committing the branch. `index.ts` is also modified by her promotes.

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
