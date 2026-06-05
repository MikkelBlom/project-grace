# Grace — Auto-Develop Workflow (Self-Built Tools)

Grace writes her own tools, tests them, and plugs them in autonomously. 
One-file-per-tool makes this conflict-free — a tool is just a new file + one import line.

## The Auto-Dev Loop

1. **PROPOSE:** Grace writes a tool spec + TypeScript source (one file, self-registers).
2. **VALIDATE:** Builds the file and runs a smoke-test. If it fails → REVERT + read the `error TSxxxx`.
3. **FIX:** Grace edits the source based on the compiler error; re-validates. Repeat until green.
4. **PLUG IN:** On green, the tool is dynamically hot-loaded into `@grace/tools` and immediately available.

## Tool Validation & Execution Pipeline

### `scripts/scaffold-tool.mjs` (Headless Safe Build)
This script writes `packages/tools/src/tools/<name>.ts`, inserts the import into `index.ts`, runs `npm run build`, and calls it once.
**Auto-Revert:** If the build or smoke test fails, it auto-reverts (deletes the file, restores `index.ts`, rebuilds) and surfaces the exact compiler error to Grace.

### `scripts/sandbox-tool.mjs` + `sandbox/` (Docker Sandbox)
The SAFE place to build AND RUN untrusted generated code.
Builds + runs candidate tools inside an ephemeral Docker container (`node:24-alpine`) with **no host filesystem, `--network none` by default, and CPU/memory caps**.
A copy of the real `@grace/tools` is baked in. If a malicious tool tries to write to `os.homedir()`, it only hits the container's `/root` and leaves the host untouched.

## The `create_tool` Tool and `start_mission`
- **`create_tool`**: Wraps the sandbox. Grace gives a name + source → sandbox validates. Pure-compute tools auto-promote via dynamic imports (live same-turn without restart). File/network tools trigger a `confirm:true` review gate before promotion.
- **`start_mission`**: Autonomous mission driver. Grace plans a backlog (`planBacklog`), then builds through it one item at a time (`buildOneTool`). Each item is its own bounded sub-task, ensuring a per-item step cap never abruptly ends the mission. It tallies built / pending-approval / failed tools.

## The Promote Policy
The hard safety problem — *where does unreviewed generated code run?* — is solved by the Docker sandbox.
Once validated in the sandbox:
- **Auto-promote:** Trivial pure-compute tools are promoted and hot-loaded instantly.
- **Review-gate:** Tools that write files or use the network are logged as "pending approval" and await confirmation before joining the active toolset.
