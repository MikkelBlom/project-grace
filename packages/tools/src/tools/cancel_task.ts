import { registerTool, TaskRegistry } from '../registry.js';

// Stop the currently running background task (barge-in). Call this from the main
// conversation when Mikkel asks to stop, pause, or cancel what you're working on.
registerTool({
  name: 'cancel_task',
  description: 'Stop the background task you are currently running. Use it when Mikkel asks you to stop, pause, cancel, or abort the task.',
  params: {},
  async run() {
    const ok = TaskRegistry.requestCancel();
    return ok
      ? { ok: true, message: 'Stopping the current background task at its next step.' }
      : { ok: false, message: 'No background task is running.' };
  },
});
