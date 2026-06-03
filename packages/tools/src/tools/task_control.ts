import { registerTool, TaskRegistry } from '../registry.js';

// Report progress of the running background task (so Mikkel can interrupt to ask).
registerTool({
  name: 'task_status',
  description: 'Report the progress of the background task you are currently working on. Use this whenever Mikkel asks how far along you are / what you are doing.',
  params: {},
  async run() { return { status: TaskRegistry.status() }; },
});

// Kick off a LONG autonomous task (intercepted by the LLM layer, which acks then works in the background).
registerTool({
  name: 'start_background_task',
  description: 'Start a LONG, multi-step task that you should work on autonomously in the background (e.g. "find X, dig through it and report", "research Y and summarise"). You will acknowledge immediately, then plan, execute and verify on your own, and report back when done. Do NOT use this for quick questions or single lookups.',
  params: { description: { type: 'string', description: 'a clear, self-contained description of the task to perform', required: true } },
  async run(args) { return { started: true, description: String((args && args.description) || '') }; },
});
