# Guide: Grace's Tools & Capabilities

Tools are how Grace *does* things. Each tool lives in its own file under **`packages/tools/src/tools/`** and self-registers at import time.

## 1. How to Add a Tool (Developer Guide)

Adding one is ~15 lines + a build.

### The Shape of a Tool
```ts
export interface ToolSpec {
  name: string;                 // snake_case, what the model calls
  description: string;          // tells the model WHEN/HOW to use it — be precise
  params: Record<string, { type: string; description: string; required?: boolean }>;
  run(args: Record<string, any>, ctx?: ToolContext): Promise<unknown>;   // ctx.callTool(name,args) → call another tool
}
```

### Create the file: `packages/tools/src/tools/<your_tool>.ts`
```ts
import { registerTool } from '../registry.js';
// import { fetchJson } from '../registry.js';   // shared HTTP helper

registerTool({
  name: 'your_tool',
  description: 'What it does — be precise so the model knows WHEN to use it.',
  params: {
    arg1: { type: 'string', description: 'what this arg is', required: true },
  },
  async run(args) {
    const val = String(args.arg1 ?? '');
    if (!val) throw new Error('arg1 is required');
    return { result: val };
  },
});
```

### Register the import
Add one line to **`packages/tools/src/index.ts`** in the side-effect imports section:
```ts
import './tools/your_tool.js';
```

Then run `npm run build`. 
*Note: Hot-reloading is implemented via dynamic imports during auto-dev, but manual development requires explicit imports and rebuilds.*

### Rules that Matter
- **Description is everything:** The model decides from it.
- **Return `{ error }`** for expected failures; only `throw` for misuse.
- **Keep results small + serializable.**
- **Dangerous tools** (run_command, delete) must have allowlists / confirmations. Default-deny.

---

## 2. Currently Implemented Tools (46)
*Grace has an expansive local toolkit for OS operations, web requests, and autonomous development.*
- **File/OS Operations**: `read_file`, `write_file`, `edit_file`, `move_file`, `delete_file`, `write_files`, `search_files`, `find_path`, `list_dir`, `create_folder`, `open_path`, `open_browser`, `clipboard_read`, `clipboard_write`, `organize_files_by_extension`.
- **Web & Info**: `web_search`, `fetch_url`, `get_weather`, `get_location`, `get_current_time`, `news_fetcher`, `temperature_converter`, `date_difference_calculator`, `roll_dice`.
- **Memory & Personality**: `recall_memory`, `reflect_on_session`, `update_user_profile`, `update_personality`.
- **Autonomy & Workspaces**: `start_background_task`, `task_status`, `cancel_task`, `mission_control`, `create_tool`, `git_commit`, `index_projects`, `list_workspaces`, `update_scratchpad`, `export_scratchpad`, `get_scratchpad`, `verify_mutation`, `summarize_and_extract`.
- **UI Overlay & Vision**: `take_screenshot` (active/all/primary/by-number), `analyze_screen` (gemma4 native vision — describe + find element bounding box), `focus_box` (animated fly-in highlight, routed per-monitor), `get_active_context` (active app/title/fullscreen + optional selected text).
- **System**: `enter_listen_mode`.

---

## 3. Planned / Wishlist Tools
*These are critical tools explicitly mapped out for Grace's OS-layer future.*

- **Vision & Screen**: `describe_screen` (continuous narration), arrows/text annotations on the overlay (extending `focus_box`).
- **OS Context & Overlay**:
  - `inject_text(text)`: Writes directly into the active document via `nut.js` native keyboard simulation (text cursor manipulation).
  - `get_mouse_context()`: Reads exactly what UI element/text the *mouse cursor* is hovering over.
- **Developer Experience**: `generate_commit_msg` + `inject_to_terminal`, `docker_doctor`, `run_command` (sandboxed).
- **Personal Assistance & Communication**: `draft_email`, `meeting_brief`, `live_translate` (real-time in overlay), `contact_brief`, `voice_journal`.
- **Health & Wellness**: `eye_pause_tracker` (20-20-20 rule fading the overlay), `energy_tracker`, `sentiment_track`, `music_mood_match`.
- **Productivity Pro**: `smart_focus_timer` (AI-adaptive Pomodoro), `generate_agenda`.
- **Image Generation (Flux.1)**: `generate_image`, `enhance_prompt`, `vary_image`, `swap_model`.
- **Integrations via MCP**: `mcp_client` (Model Context Protocol) to seamlessly connect to external systems without hardcoding custom API wrappers.
