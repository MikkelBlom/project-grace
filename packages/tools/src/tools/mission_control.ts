import { registerTool, MissionRegistry } from '../registry.js';

// Kick off a LONG autonomous MISSION — hours of self-directed work toward a high-level
// objective (e.g. "research agent tooling, then design, build, test and validate 20+ new
// tools for yourself"). Intercepted by the LLM layer, which plans a backlog and then works
// through it one item at a time, surviving the per-item step caps, until the backlog is empty
// or Mikkel stops it. Use this — NOT start_background_task — for open-ended, many-step goals
// that should run unattended.
registerTool({
  name: 'start_mission',
  description: 'Begin a LONG autonomous mission toward a high-level objective that needs MANY steps over a long time (e.g. "research X, then build, test and validate 20+ new tools"). You acknowledge, plan a backlog, then work through it item by item on your own — continuing past the normal step limits — and report progress. Mikkel can say "status", "pause" or "stop" (or use the hotkeys) at any time. Do NOT use for a single tool or a quick task; use create_tool or start_background_task for those.',
  params: {
    objective: { type: 'string', description: 'a clear, self-contained description of the overall mission', required: true },
  },
  async run(args) {
    if (MissionRegistry.isRunning()) {
      return { started: false, error: 'A mission is already running. Say "status" to check it, or "stop" to end it first.' };
    }
    return { started: true, objective: String((args && args.objective) || '') };
  },
});

// Report mission progress (so Mikkel can ask "how far are you?" by voice).
registerTool({
  name: 'mission_status',
  description: 'Report the progress of the autonomous mission you are working on. Use when Mikkel asks how the mission is going.',
  params: {},
  async run() { return { status: MissionRegistry.status() }; },
});
