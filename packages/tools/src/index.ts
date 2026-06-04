// ─────────────────────────────────────────────
// Grace — tool entry point
//
// Re-exports the public API from registry.ts and loads every tool file
// so they self-register via registerTool() at import time.
//
// To add a new tool: create packages/tools/src/tools/<name>.ts, then add
// one `import './tools/<name>.js';` line below. See docs/adding-tools.md.
// ─────────────────────────────────────────────

// ── Public API (re-exported from registry) ───────────────────────
export type { ToolSpec, ToolInvocation, ToolCall, TaskState, MissionState } from './registry.js';
export { registerTool, listTools, describeTools, parseToolCall, runTool, fetchJson, TaskRegistry, MissionRegistry } from './registry.js';

// ── Side-effect imports: each file self-registers its tool(s) ────
import './tools/get_location.js';
import './tools/get_weather.js';
import './tools/search_files.js';
import './tools/web_search.js';
import './tools/read_file.js';
import './tools/create_tool.js';
import './tools/create_folder.js';
import './tools/fetch_url.js';
import './tools/write_file.js';
import './tools/write_files.js';
import './tools/edit_file.js';
import './tools/move_file.js';
import './tools/delete_file.js';
import './tools/list_dir.js';
import './tools/open_browser.js';
import './tools/open_path.js';
import './tools/clipboard.js';
import './tools/task_control.js';
import './tools/mission_control.js';
import './tools/enter_listen_mode.js';
import './tools/cancel_task.js';
import './tools/get_current_time.js';
import './tools/roll_dice.js';
import './tools/news_fetcher.js';
