import { bus } from '@grace/core';
import { registerTool } from '../registry.js';

let hushTimer: ReturnType<typeof setTimeout> | null = null;

// Privacy hush — pause listening for a while (or until Mikkel resumes).
registerTool({
  name: 'privacy_hush',
  description: 'Stop listening for a while (privacy). Grace pauses and will not respond until the time is up or Mikkel resumes. Use when he asks for privacy, quiet, or to mute Grace temporarily.',
  params: { minutes: { type: 'number', description: 'how long to hush (default 15, max 240)' } },
  async run(args) {
    const min = Math.max(1, Math.min(240, Number(args.minutes) || 15));
    bus.emit('power:stateChange', { state: 'paused', reason: 'privacy hush' });
    bus.emit('overlay:show', { type: 'paused' });
    if (hushTimer) clearTimeout(hushTimer);
    hushTimer = setTimeout(() => {
      bus.emit('power:stateChange', { state: 'active', reason: 'hush ended' });
      bus.emit('overlay:show', { type: 'listening' });
    }, min * 60_000);
    return { ok: true, hushedForMinutes: min, note: 'Listening paused for privacy. Wait it out or say "resume" to come back.' };
  },
});

// Discreet mode — HUD-only, nothing logged (uses the existing discreet mode).
registerTool({
  name: 'set_discreet_mode',
  description: 'Toggle discreet mode — HUD-only output, nothing logged to memory, minimal/quiet responses. Use when Mikkel wants the conversation kept private.',
  params: { on: { type: 'boolean', description: 'true to enter discreet mode, false to leave', required: true } },
  async run(args) {
    const on = args.on === true || String(args.on) === 'true';
    bus.emit('system:modeChange', { mode: on ? 'discreet' : 'normal', reason: 'tool' });
    return { ok: true, discreet: on };
  },
});

// Evening wind-down — dim the overlay, keep replies short + calm.
registerTool({
  name: 'wind_down_mode',
  description: 'Evening wind-down — dims the overlay and signals Grace to keep replies short and calm. Use in the evening or when Mikkel is winding down.',
  params: { on: { type: 'boolean', description: 'true to enable, false to disable', required: true } },
  async run(args) {
    const on = args.on === true || String(args.on) === 'true';
    bus.emit('overlay:notification', { text: on ? '🌙 Wind-down — dimmed & calm' : '☀ Wind-down off', level: 'info', duration: 4000 });
    return { ok: true, windDown: on, note: on ? 'Wind-down on — I will keep it calm and brief this evening.' : 'Back to normal energy.' };
  },
});
