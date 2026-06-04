# Guide: Adding a Tool to Grace

Tools are how Grace *does* things. Each tool lives in its own file under
**`packages/tools/src/tools/`** and self-registers at import time.
Adding one is ~15 lines + a build.

## 1. The shape of a tool
```ts
export interface ToolSpec {
  name: string;                 // snake_case, what the model calls
  description: string;          // tells the model WHEN/HOW to use it — be precise
  params: Record<string, { type: string; description: string; required?: boolean }>;
  run(args: Record<string, any>): Promise<unknown>;   // returns JSON-serializable data
}
```

## 2. Create a tool file

Create **`packages/tools/src/tools/<your_tool>.ts`**:
```ts
import { registerTool } from '../registry.js';
// import { fetchJson } from '../registry.js';   // if you need the shared HTTP helper

registerTool({
  name: 'your_tool',
  description: 'What it does — be precise so the model knows WHEN to use it.',
  params: {
    arg1: { type: 'string', description: 'what this arg is', required: true },
  },
  async run(args) {
    const val = String(args.arg1 ?? '');
    if (!val) throw new Error('arg1 is required');
    // ... do the work ...
    return { result: val };
  },
});
```

## 3. Register the import

Add one line to **`packages/tools/src/index.ts`** in the side-effect imports section:
```ts
import './tools/your_tool.js';
```

That's it — `describeTools()` now lists it in the system prompt, and the multi-step loop +
autonomous tasks can call it. No other wiring.

## 4. Rules that matter
- **Description is everything** — the model decides from it. Say when to use it and how args map.
- **Return `{ error }` for expected failures** (missing file, HTTP 404); only `throw` for misuse.
- **Keep results small + serializable** (cap arrays, slice long text). The result is fed back to the LLM.
- **Never hang** — wrap network calls in `AbortSignal.timeout(ms)`.
- **Stay local** for processing; free no-key public APIs are fine for info (weather/web).
- **Dangerous tools** (run_command, write_file, delete) must have an allowlist / confirmation and
  should be sandboxed (see ROADMAP P4/P5). Default-deny.

## 5. Build & test (headless — no need to launch the app)
```powershell
npm run build                              # must be exit 0
node -e "(async()=>{const t=await import('./packages/tools/dist/index.js'); \
  console.log(t.listTools().map(x=>x.name).join(', ')); \
  console.log(await t.runTool('your_tool',{arg1:'hello'}))})()"
```
For a tool the LLM must *choose*, test that too: build the system prompt from
`personality.json` + `t.describeTools()`, send a user message to Ollama (`gemma4:26b`,
`think:false`) and assert it emits the right tool JSON. (See git history `_nav_test.mjs` /
`_auto_test.mjs` patterns — write a temp `.mjs`, run, delete.)

## 6. Commit
Small, focused: `Add your_tool tool` + the Co-Authored-By trailer used in `git log`.

---

## Tool wishlist (each is a good standalone PR)

| Tool | Params | Returns | Notes / difficulty |
|---|---|---|---|
| `take_screenshot` | (displayIndex?) | pngBase64/path | Electron `desktopCapturer`; **then** vision below |
| `describe_screen` | — | text | screenshot → LLaVA via Ollama `/api/generate` (see tools/definitions/ui-self-test.ts) |
| `app_context` | — | {app, title, url} | already polled by ContextDetector; expose it as a tool |
| `create_reminder` | text, when | id | needs the scheduler (ROADMAP P2) |
| `system_volume` / `media_control` | action | ok | PowerShell / nircmd; small |
| `git_status` / `git_log` | repoPath | text | `child_process` git; read-only first |
| `run_command` | cmd | stdout | **sandbox + allowlist only** — high risk; do last |
| `calendar_*` | — | events | Google OAuth (heavier); or local .ics |

Start with `take_screenshot`+`describe_screen`, `app_context`, then `create_reminder`.

**Multiple tool calls per turn (DONE):** the model can emit
`{ "tools": [ {"tool":"get_location","args":{}}, {"tool":"get_weather","args":{"city":"X"}} ] }`
to run independent tools in one turn; `parseToolCall` normalizes it and the loop runs them in parallel.
Batch only independent calls — dependent steps still go one turn at a time.
