import { registerTool } from '../registry.js';
import { eyePause } from '@grace/core';

registerTool({
  name: 'start_eye_pause',
  description: 'Turn on the 20-20-20 eye-strain reminder (every ~20 min, look ~20 feet away for 20 seconds). Use when Mikkel asks for eye-break reminders or to protect his eyes during long screen sessions.',
  params: { minutes: { type: 'number', description: 'interval in minutes (default 20)' } },
  async run(args) { return eyePause.start(Number(args.minutes) || 20); },
});

registerTool({
  name: 'stop_eye_pause',
  description: 'Turn off the 20-20-20 eye-strain reminder.',
  params: {},
  async run() { return eyePause.stop(); },
});
