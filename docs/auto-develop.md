# Grace — Auto-Develop Workflow (self-built tools)

The north star (ROADMAP P5): **Grace writes her own tools, tests them, and plugs them in.**
One-file-per-tool makes this conflict-free — a tool is just a new file + one import line.

This doc describes the workflow, what exists today, and the one open safety decision.

## The loop

```
1. PROPOSE   Grace writes a tool spec + TypeScript source (one file, self-registers via registerTool).
2. VALIDATE  Write the file, patch index.ts, BUILD, smoke-test. If it fails → REVERT + read the error.
3. FIX       Feed the tsc error back; Grace edits the source; re-validate. Repeat until green.
4. PLUG IN   On green, the tool is registered — describeTools() lists it, the loop can call it.
5. (LATER)   auto_git_commit the new tool file + import.
```

## What exists today ✅

**`scripts/scaffold-tool.mjs`** — the VALIDATE step, safe and headless:
```bash
node scripts/scaffold-tool.mjs add <name> --from <file.ts> --smoke '{"arg":"v"}'
node scripts/scaffold-tool.mjs add <name> --stdin           # pipe source in
node scripts/scaffold-tool.mjs add <name> --stub            # minimal valid template
node scripts/scaffold-tool.mjs remove <name>
node scripts/scaffold-tool.mjs list
```
It writes `packages/tools/src/tools/<name>.ts`, inserts `import './tools/<name>.js';` into
`index.ts`, runs `npm run build`, then loads the tool and (optionally) calls it once. **If the
build or smoke test fails it auto-reverts** (deletes the file, restores index.ts, rebuilds) and
prints the real `error TSxxxx` line — so the tree never ends up broken and the error is fixable.

Proven: stub add + smoke + remove leaves the tree clean; a type-error tool fails the build and
reverts cleanly with the exact compiler error surfaced.

## What's left

- **`create_tool` Grace tool** — a thin wrapper so Grace can drive the scaffolder from a background
  task (PROPOSE→VALIDATE→FIX in the autonomous loop). Trivial once the safety decision below is made.
- **Hot-load without restart** — today a new tool is live after the next app start (explicit imports,
  NodeNext; see HANDOFF "Dynamic Loader vs Explicit Imports"). Good enough to start; hot-load later.
- **`auto_git_commit`** — commit the new tool file + import after it goes green.

## ⚠️ The open safety decision: where does generated code RUN?

Validating a tool **executes** its module-load + `run()` code with full Node privileges (it can
touch the filesystem, network, etc.). That is fine when a human/AI has read the source first — it is
**not** fine for voice-triggered, unreviewed code.

Two paths (pick before wiring `create_tool` to voice):

1. **In-process (fast, riskier).** Grace builds + runs generated tools directly in the Electron main
   process. Acceptable only because this is a single-user machine the user owns — but a hallucinated
   `rm -rf`-equivalent would run for real. Mitigation: keep the home-folder gate, diff the source for
   review, and require a spoken confirmation before the first run of a new tool.
2. **Sandbox (safe, more work — ROADMAP P4/P5).** Build + smoke-test generated tools inside a Docker
   container (or a locked-down child process) with no access to the real filesystem; only promote to
   the real tree after it passes. This is the original vision and the right long-term answer.

**Recommendation:** ship `create_tool` against the scaffolder in **review mode first** (Grace
proposes, the diff is shown/logged, the user okays it), then add the Docker sandbox for unattended
self-expansion. The scaffolder already gives the safe build/test/revert core either way.
