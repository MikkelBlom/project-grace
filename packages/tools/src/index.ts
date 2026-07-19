// ─────────────────────────────────────────────
// Grace — tool entry point
//
// Re-exports the public API from registry.ts and loads every tool file
// so they self-register via registerTool() at import time.
//
// To add a new tool: create packages/tools/src/tools/<name>.ts, then add
// one `import './tools/<name>.js';` line below. See docs/3-TOOLS.md.
// ─────────────────────────────────────────────

// ── Public API (re-exported from registry) ───────────────────────
export type { ToolSpec, ToolInvocation, ToolCall, TaskState, MissionState } from './registry.js';
export { registerTool, listTools, describeTools, parseToolCall, runTool, fetchJson, TaskRegistry, MissionRegistry } from './registry.js';

// ── Side-effect imports: each file self-registers its tool(s) ────
import './tools/get_location.js';
import './tools/get_weather.js';
import './tools/search_files.js';
import './tools/web_search.js';
import './tools/research.js';
import './tools/set_language.js';
import './tools/add_stt_correction.js';
import './tools/find_file.js';
import './tools/index_folders.js';
import './tools/focus.js';
import './tools/search_content.js';
import './tools/system_status.js';
import './tools/recent_files.js';
import './tools/notes.js';
import './tools/todo.js';
import './tools/wikipedia.js';
import './tools/translate.js';
import './tools/define.js';
import './tools/draft_email.js';
import './tools/git_repo.js';
import './tools/disk_usage.js';
import './tools/weather_forecast.js';
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
import './tools/git_commit.js';
import './tools/cancel_task.js';
import './tools/get_current_time.js';
import './tools/roll_dice.js';
import './tools/news_fetcher.js';
import './tools/organize_files_by_extension.js';
import './tools/update_scratchpad.js';
import './tools/update_user_profile.js';
import './tools/recall_memory.js';
import './tools/get_scratchpad.js';
import './tools/list_workspaces.js';
import './tools/export_scratchpad.js';
import './tools/index_projects.js';
import './tools/find_path.js';
import './tools/verify_mutation.js';
import './tools/reflect_on_session.js';
import './tools/update_personality.js';
// ── UI overlay & vision ──
import './tools/focus_box.js';
import './tools/get_active_context.js';
import './tools/take_screenshot.js';
import './tools/analyze_screen.js';
