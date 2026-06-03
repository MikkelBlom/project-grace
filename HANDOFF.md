# HANDOFF — refactor/one-file-per-tool

## Branch & Commits

**Branch:** `refactor/one-file-per-tool` (do NOT merge to main yet)

| # | Hash | Message |
|---|------|---------|
| 1 | `a674ffa` | Extract tool framework into registry.ts |
| 2 | `3db5bde` | Move built-in tools to individual files |
| 3 | `8e0880a` | Rewrite index.ts as re-export hub with explicit tool imports |
| 4 | `c119132` | Update docs and add HANDOFF.md |
| 5 | `fd51686` | Fix narration guard: catch past-tense false claims of tool actions |

---

## Bug Fix: Grace Claims Actions Without Calling Tools (commit 5)

### The Problem

From the live session logs, all 16 tools work correctly when called — `write_file`
creates files, `move_file` moves them, `delete_file` deletes them. The bug was in the
**LLM tool loop** in `packages/llm/src/OllamaLLM.ts`.

The narration guard (line 229) only caught **future-tense intent**:
```
"let me search…", "I'll find…", "I'm going to check…"
```

The LLM was bypassing it by responding with **past-tense or present-progressive
false claims**:
```
"I've moved the file back to your Desktop"
"I've updated the file now with the header"
"I'm writing the header to the file right now"
"I'm fixing it right now"
```

These prose responses contained no tool-call JSON, so the system treated them as
valid final answers. **The action was never performed — the LLM just hallucinated
having done it.**

### The Fix

Added a `falseClaim` regex that catches `I've/I'm/I have` + action verbs in both
English and Danish (moved, moving, written, writing, updated, updating, created,
creating, fixed, fixing, etc.). When triggered in a step with no tool call, the
model is told:

> "You CLAIMED you already did something but you did NOT call any tool — words
> alone do not change files. Output the tool-call JSON right now to ACTUALLY do it."

Applied to both the main tool loop (line ~226-240) and the background task loop
(line ~359-367).

### Regex Test Results (all 13 pass)

```
✅ CAUGHT "I've moved the file back to the overførsler folder"
✅ CAUGHT "I've updated the file now with the header"
✅ CAUGHT "I'm fixing it right now"
✅ CAUGHT "I'm rewriting it now"
✅ CAUGHT "I've clearly been missing the mark. I've moved the file back"
✅ CAUGHT "Done. I've created the new file on your Desktop"
✅ CAUGHT "I'm writing the header to the file right now"
✅ CAUGHT "I have saved the changes"
✅ PASS  "Brilliant - running locally and loving it. What are you up to?"
✅ PASS  "Here is the full list of the 16 tools available to me:"
✅ PASS  "Thanks, Mikkel. I try my best. What's our next move?"
✅ PASS  "Sorry, I couldn't find that file anywhere."
✅ PASS  "The weather in Copenhagen is 15 degrees."
```

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

### Full file-operation integration test

```
--- write new ---
{"path":"C:\\Users\\mikke\\Desktop\\grace_test.txt","bytes":8,"mode":"overwrite","ok":true}
--- overwrite ---
{"path":"C:\\Users\\mikke\\Desktop\\grace_test.txt","bytes":11,"mode":"overwrite","ok":true}
--- read back ---
{"path":"C:\\Users\\mikke\\Desktop\\grace_test.txt","totalLines":1,"returned":1,"text":"OVERWRITTEN"}
--- move ---
{"from":"C:\\Users\\mikke\\Desktop\\grace_test.txt","to":"C:\\Users\\mikke\\Desktop\\grace_test_moved.txt","ok":true}
--- read moved ---
{"path":"C:\\Users\\mikke\\Desktop\\grace_test_moved.txt","totalLines":1,"returned":1,"text":"OVERWRITTEN"}
--- delete ---
{"path":"C:\\Users\\mikke\\Desktop\\grace_test_moved.txt","ok":true}
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

- **`packages/llm/src/OllamaLLM.ts`** — added `falseClaim` regex to narration guard
  in both the main tool loop and background task loop (commit 5). This is a logic fix,
  not a tool relocation.

## Uncertainty

- The `falseClaim` regex is broad by design — it catches "I've/I'm + action verb" patterns.
  There is a small chance of false positives if the LLM legitimately says e.g. "I've moved on
  to the next topic" after a non-file-related query. However, this only costs one extra tool-loop
  iteration (the model will respond with prose again and the loop proceeds), which is far better
  than the current failure where the LLM claims it acted and the user sees nothing happen.

- The guard has no way to distinguish a *legitimate* report of a completed action (after a
  tool call succeeded in a *previous* step) from a false claim. However, after a successful
  tool call, the model's next reply typically includes the tool result summary and naturally
  reads as prose ("Done. The file is on your Desktop.") without matching the `I've moved`
  pattern — so this should not cause issues in practice.
