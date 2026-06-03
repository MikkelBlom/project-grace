# HANDOFF — refactor/one-file-per-tool

## Branch & Commits

**Branch:** `refactor/one-file-per-tool` (do NOT merge to main yet)

| # | Hash | Message |
|---|------|---------|
| 1 | `a674ffa` | Extract tool framework into registry.ts |
| 2 | `3db5bde` | Move built-in tools to individual files |
| 3 | `8e0880a` | Rewrite index.ts as re-export hub with explicit tool imports |
| 4 | `b5b2f2c` | Update docs and add HANDOFF.md |

---

## New Structure

```
packages/tools/src/
  registry.ts          # Framework: ToolSpec, registerTool, listTools, describeTools,
                       #   parseToolCall, runTool, fetchJson, TaskState, TaskRegistry
  tools/
    get_location.ts    # get_location
    get_weather.ts     # get_weather
    search_files.ts    # search_files
    web_search.ts      # web_search
    read_file.ts       # read_file
    fetch_url.ts       # fetch_url
    write_file.ts      # write_file
    move_file.ts       # move_file
    delete_file.ts     # delete_file
    list_dir.ts        # list_dir
    open_browser.ts    # open_browser
    open_path.ts       # open_path
    clipboard.ts       # clipboard_read + clipboard_write
    task_control.ts    # task_status + start_background_task
  index.ts             # Re-export hub + side-effect imports to load tools
```

## How to Add a Tool Now (3 lines)

1. Create `packages/tools/src/tools/my_tool.ts`:
   ```ts
   import { registerTool } from '../registry.js';
   registerTool({ name: 'my_tool', description: '...', params: {}, async run(args) { return {}; } });
   ```
2. Add `import './tools/my_tool.js';` to `packages/tools/src/index.ts`.
3. `npm run build` — done.

---

## Dynamic Loader vs Explicit Imports

**Used: explicit imports** (one `import './tools/<name>.js';` per tool in index.ts).

**Why not a dynamic loader?**
- The project uses `"module": "NodeNext"` in tsconfig. Top-level await requires
  `"module": "esnext"` or `"es2022"` — changing that would break `tsc -b` composite
  project references across the monorepo.
- This runs inside Electron's main process where dynamic imports from `readdirSync`
  results can behave inconsistently depending on packaging (asar, etc.).
- Explicit imports are deterministic, type-checked at compile time, and zero-surprise.
- The trade-off is one extra line per new tool — trivially small vs the merge-conflict
  risk of editing the tool code itself (which is now zero).

---

## Validation Output

### Build (`npm run build` → exit 0)

```
> grace@0.1.0 build
> npm run build --workspaces --if-present

> @grace/shared@0.1.0 build
> tsc

> @grace/core@0.1.0 build
> tsc

> @grace/llm@0.1.0 build
> tsc -b

> @grace/overlay@0.1.0 build
> tsc -b

> @grace/stt@0.1.0 build
> tsc

> @grace/tools@0.1.0 build
> tsc

> @grace/tts@0.1.0 build
> tsc
```

### 16-tool list (all names preserved)

```
> node -e "import('./packages/tools/dist/index.js').then(t=>console.log(t.listTools().length, t.listTools().map(x=>x.name).join(',')))"

16 get_location,get_weather,search_files,web_search,read_file,fetch_url,write_file,move_file,delete_file,list_dir,open_browser,open_path,clipboard_read,clipboard_write,task_status,start_background_task
```

### Gate checks

```
--- delete_file outside home ---
{"error":"Refused: C:\\Windows\\System32\\notepad.exe is outside your home folder (C:\\Users\\mikke). Only files under home can be deleted."}

--- open_path .exe under home ---
{"error":"Refused: C:\\Users\\mikke\\malware.exe looks executable (.exe). open_path will not run programs or scripts — open documents, folders, or media instead."}

--- write_file relative Downloads/x.txt ---
{"path":"C:\\Users\\mikke\\Downloads\\test-gate-check.txt","bytes":5,"mode":"overwrite","ok":true}
(cleaned up test file)
```

---

## Changes Beyond a Pure Move

- **`fetchJson` is now `export`** — it was a module-private `async function` in the old
  index.ts. The tool files `get_location.ts` and `get_weather.ts` need to import it, so it
  had to become a named export from `registry.ts`. It is also re-exported from `index.ts`
  but this does NOT change the `@grace/tools` public API contract (no existing consumer
  imports `fetchJson`).

- **`docs/architecture.md`** — updated the "Tools" section to describe the new structure
  (`registry.ts` + `tools/*.ts` + `index.ts` hub) instead of the monolithic file.

- **`docs/adding-tools.md`** — rewritten to describe the new workflow (create a file,
  add one import, build). Removed already-implemented tools from the wishlist table.

- **`packages/tools/tsconfig.json`** — broadened `include` from `["src/index.ts"]` to
  `["src"]` so tsc picks up all new files.

## Uncertainty

- None. Build is green, all 16 tools register, all gate checks pass, OllamaLLM.ts compiles
  unchanged. The refactor is a pure relocation with the one minor change noted above
  (fetchJson export).
