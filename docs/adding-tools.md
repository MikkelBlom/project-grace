# Guide: Adding a Tool to Grace

Tools are how Grace *does* things. They live in **`packages/tools/src/index.ts`** and are
auto-exposed to the LLM. Adding one is ~15 lines + a test.

## 1. The shape of a tool
```ts
export interface ToolSpec {
  name: string;                 // snake_case, what the model calls
  description: string;          // tells the model WHEN/HOW to use it — be precise
  params: Record<string, { type: string; description: string; required?: boolean }>;
  run(args: Record<string, any>): Promise<unknown>;   // returns JSON-serializable data
}
```

## 2. Register it
At the bottom of `packages/tools/src/index.ts`:
```ts
registerTool({
  name: 'list_dir',
  description: 'List the immediate contents of a folder by absolute path. Use after search_files to look inside a folder.',
  params: {
    path: { type: 'string', description: 'absolute path to the folder', required: true },
  },
  async run(args) {
    const fs = await import('fs/promises');
    const p = String(args.path ?? '');
    if (!p) throw new Error('path is required');               // unexpected misuse: throw
    try {
      const entries = await fs.readdir(p, { withFileTypes: true });
      return {
        path: p,
        items: entries.slice(0, 100).map(e => ({ name: e.name, type: e.isDirectory() ? 'folder' : 'file' })),
      };
    } catch (e) {
      return { path: p, error: String(e) };                    // expected failure: return {error}
    }
  },
});
```
That's it — `describeTools()` now lists it in the system prompt, and the multi-step loop +
autonomous tasks can call it. No other wiring.

## 3. Rules that matter
- **Description is everything** — the model decides from it. Say when to use it and how args map.
- **Return `{ error }` for expected failures** (missing file, HTTP 404); only `throw` for misuse.
- **Keep results small + serializable** (cap arrays, slice long text). The result is fed back to the LLM.
- **Never hang** — wrap network calls in `AbortSignal.timeout(ms)`.
- **Stay local** for processing; free no-key public APIs are fine for info (weather/web).
- **Dangerous tools** (run_command, write_file, delete) must have an allowlist / confirmation and
  should be sandboxed (see ROADMAP P4/P5). Default-deny.

## 4. Build & test (headless — no need to launch the app)
```powershell
npm run build                              # must be exit 0
node -e "(async()=>{const t=await import('./packages/tools/dist/index.js'); \
  console.log(t.listTools().map(x=>x.name).join(', ')); \
  console.log(await t.runTool('list_dir',{path:'C:/Users/mikke/Downloads'}))})()"
```
For a tool the LLM must *choose*, test that too: build the system prompt from
`personality.json` + `t.describeTools()`, send a user message to Ollama (`gemma4:26b`,
`think:false`) and assert it emits the right tool JSON. (See git history `_nav_test.mjs` /
`_auto_test.mjs` patterns — write a temp `.mjs`, run, delete.)

## 5. Commit
Small, focused: `Add list_dir tool` + the Co-Authored-By trailer used in `git log`.

---

## Tool wishlist (each is a good standalone PR)

| Tool | Params | Returns | Notes / difficulty |
|---|---|---|---|
| `list_dir` | path | items[] | trivial; pairs with search_files |
| `write_file` | path, content, mode(append?) | ok | **gate**: only under user's home; confirm/allowlist |
| `open_path` | path | ok | `child_process` `start ""` (Windows) to open file/folder/app |
| `clipboard_read` / `clipboard_write` | (text) | text/ok | PowerShell `Get/Set-Clipboard` or a node lib |
| `take_screenshot` | (displayIndex?) | pngBase64/path | Electron `desktopCapturer`; **then** vision below |
| `describe_screen` | — | text | screenshot → LLaVA via Ollama `/api/generate` (see tools/definitions/ui-self-test.ts) |
| `app_context` | — | {app, title, url} | already polled by ContextDetector; expose it as a tool |
| `create_reminder` | text, when | id | needs the scheduler (ROADMAP P2) |
| `system_volume` / `media_control` | action | ok | PowerShell / nircmd; small |
| `git_status` / `git_log` | repoPath | text | `child_process` git; read-only first |
| `run_command` | cmd | stdout | **sandbox + allowlist only** — high risk; do last |
| `calendar_*` | — | events | Google OAuth (heavier); or local .ics |

Start with `list_dir`, `write_file` (gated), `clipboard_*`, `open_path`, `app_context`,
`take_screenshot`+`describe_screen`. Add **multiple-tool-calls-per-turn** (ROADMAP P1) so
compound requests work.
