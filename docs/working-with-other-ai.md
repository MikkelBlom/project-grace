# Working with other AI assistants (Antigravity / Copilot / etc.) in parallel

You can have other AI tools implement roadmap items while Claude is on cooldown, then Claude
double-checks. This is the workflow that keeps it safe and mergeable.

## The loop
1. **Pick one ROADMAP item.** Small and self-contained beats big and vague.
2. **Brief the other AI with these three files:** `docs/architecture.md`,
   `docs/adding-tools.md`, and the specific ROADMAP entry. Tell it the constraints below.
3. **It implements on a branch** (`git checkout -b feat/<thing>`), keeping changes focused.
4. **It MUST self-validate before claiming done** (see checklist). No "should work".
5. **It commits** with a clear message + the Co-Authored-By trailer (match `git log` style).
6. **Claude reviews later:** reads the diff, rebuilds, re-runs the tests, checks for regressions
   and the guardrails, and either approves or sends back precise fixes.

## Hard constraints to give every AI
- **100% local** for models/processing. No cloud LLM/STT/TTS. Free no-key public APIs (weather,
  web search) are OK for *information*.
- **Don't break the build.** `npm run build` must be exit 0. Don't touch the `tsc -b` /
  workspace wiring unless the task is about that.
- **Don't regress existing behavior.** The multi-step loop, autonomous tasks, personality,
  memory, and the EventBus contracts in `shared/src/events.ts` are load-bearing.
- **Tools:** follow `docs/adding-tools.md` exactly (register in `@grace/tools`, `{error}` on
  expected failure, serializable results, timeouts, default-deny for dangerous actions).
- **Keep commits small and focused**; one roadmap item per branch.

## Self-validation checklist (the other AI must do this, not just assert)
- [ ] `npm run build` → exit 0 (paste the tail).
- [ ] For a tool: headless `node` test showing it appears in `listTools()` and `runTool` returns
      sensible data (paste output).
- [ ] For LLM-facing behavior: a temp `.mjs` sim (see `adding-tools.md`) proving the model uses it
      correctly against Ollama; delete the temp file after.
- [ ] No new files committed that should be gitignored (no `dist/`, `node_modules/`, `data/`, models).
- [ ] Briefly state what was NOT tested and why (e.g. live audio needs the user's ears).

## What Claude will check on review
- Build is green; the diff matches the intent; no scope creep.
- Tools return `{error}` not throws for expected failures; results are bounded.
- No secrets, no cloud calls for core AI, no broken event contracts.
- Re-runs the provided test + a quick regression of the multi-step loop.
- Squashes/relabels commits if needed; merges to `main`.

## Good first items to hand off
- `list_dir`, `write_file` (gated to home), `clipboard_read/write`, `open_path`, `app_context`
  (expose ContextDetector), `take_screenshot` + `describe_screen` (LLaVA), STT `lang="auto"`.
- **Multiple tool calls per turn** (ROADMAP P1) — model emits a JSON array of calls; parse + run in
  parallel; feed all results back. Touches `OllamaLLM` loop + `parseToolCall`; test with a sim.

## Handover note format (paste back to Claude)
```
Item: <roadmap entry>
Branch/commit: <hash>
What changed: <1-3 lines>
Validation: <build result + test output>
Not tested: <what + why>
Open questions: <if any>
```
Claude validates from that.
