# Grace — Auto-Develop Workflow (self-built tools)

The north star (ROADMAP P5): **Grace writes her own tools, tests them, and plugs them in.**
One-file-per-tool makes this conflict-free — a tool is just a new file + one import line.

This doc describes the workflow, what exists today (incl. the Docker sandbox), and the remaining promote decision.

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

**`scripts/sandbox-tool.mjs` + `sandbox/`** — the SAFE place to build AND RUN untrusted generated code:
```bash
node scripts/sandbox-tool.mjs <name> --from <file.ts> --smoke '{"a":1}'         # validate in isolation
node scripts/sandbox-tool.mjs <name> --from <file.ts> --smoke '{}' --promote     # + land in real tree on pass
node scripts/sandbox-tool.mjs <name> --from <file.ts> --allow-net --rebuild      # net for the tool; rebuild image
```
Builds + runs the candidate inside an ephemeral Docker container (`node:24-alpine`) with **no host
filesystem, `--network none` by default, and CPU/memory/pid caps**, then prints a JSON verdict. A copy
of the real `@grace/tools` is baked in so a sandbox pass == a real build pass. With `--promote`, a
passing tool is handed to `scaffold-tool.mjs` (which re-builds + auto-reverts in the real tree). Use
`--rebuild` after changing the tools framework.

Proven: a valid tool passes + smoke-runs; a type-error tool fails at the build stage with the exact
`error TSxxxx`; a malicious tool writing to `os.homedir()` writes to the container's `/root` and leaves
the host **untouched** (verified — nothing lands on `C:\Users\mikke`).

## What's left

- **`create_tool` Grace tool** — a thin wrapper over `sandbox-tool.mjs` so Grace can drive
  PROPOSE→VALIDATE→FIX→PROMOTE from a background task. The safe execution layer it needs now exists.
- **Hot-load without restart** — today a new tool is live after the next app start (explicit imports,
  NodeNext; see HANDOFF "Dynamic Loader vs Explicit Imports"). Good enough to start; hot-load later.
- **`auto_git_commit`** — commit the new tool file + import after it goes green.

## ⚠️ Remaining decision: the PROMOTE policy

The hard safety problem — *where does unreviewed generated code run?* — is solved: the Docker sandbox
above builds and executes candidates with **no host access**. What's left to decide is the **promote
policy**: once a tool passes in the sandbox, does it land in the real tree automatically, or only after
Mikkel okays the diff?

- **Auto-promote** everything that passes — fastest path to self-expansion; fine for low-risk tools
  (pure compute, read-only public APIs).
- **Review-gate** — Grace proposes + sandbox-validates, then shows/logs the diff and waits for a "yes"
  before promoting. Safer for tools that touch files or the network.

**Recommendation:** `create_tool` always validates in the sandbox (unattended is safe now), auto-promotes
trivial tools, and asks for confirmation for anything that writes files or uses the network. Build it as
a thin wrapper over `sandbox-tool.mjs --promote`.

> The in-process path (running generated code directly in Electron) is no longer needed for safety — use
> the sandbox. Keep the home-folder gate on the real tools regardless.
