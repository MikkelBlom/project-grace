import { scheduler } from '@grace/core';
import { registerTool } from '../registry.js';

// Recurring wellness nudges (posture, hydration) via the scheduler's recurring reminders.
registerTool({
  name: 'start_wellness_reminders',
  description: 'Turn on recurring wellness nudges — posture check and hydration reminders every N minutes. Use when Mikkel asks for posture/water/break reminders during long work.',
  params: {
    postureMinutes: { type: 'number', description: 'posture reminder interval (default 45; 0 to skip)' },
    hydrationMinutes: { type: 'number', description: 'hydration reminder interval (default 60; 0 to skip)' },
  },
  async run(args) {
    // Clear any prior wellness reminders first.
    scheduler.cancel('wellness-posture');
    scheduler.cancel('wellness-hydration');
    const posture = args.postureMinutes != null ? Number(args.postureMinutes) : 45;
    const hydration = args.hydrationMinutes != null ? Number(args.hydrationMinutes) : 60;
    const started: string[] = [];
    if (posture > 0) { scheduler.add('sit up straight and roll your shoulders', Date.now() + posture * 60000, posture * 60000, 'wellness-posture'); started.push(`posture/${posture}min`); }
    if (hydration > 0) { scheduler.add('drink some water', Date.now() + hydration * 60000, hydration * 60000, 'wellness-hydration'); started.push(`hydration/${hydration}min`); }
    return { ok: true, started };
  },
});

registerTool({
  name: 'stop_wellness_reminders',
  description: 'Turn off the recurring posture/hydration wellness nudges.',
  params: {},
  async run() {
    const p = scheduler.cancel('wellness-posture');
    const h = scheduler.cancel('wellness-hydration');
    return { ok: true, stopped: p || h };
  },
});
