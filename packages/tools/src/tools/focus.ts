import { registerTool } from '../registry.js';
import { focusTimer } from '@grace/core';

// Deep Work / focus timer mode — the vision doc's "Smart Focus Timer", as usable tools.

registerTool({
  name: 'start_focus',
  description: 'Start a Deep Work / focus session (Pomodoro-style timer). Use when Mikkel says "start a focus session", "deep work", "focus for 50 minutes", "lad os fokusere", "start en fokus-timer". Grace announces when time is up and suggests a break.',
  params: {
    minutes: { type: 'number', description: 'length in minutes (default 25)' },
    task: { type: 'string', description: 'optional: what he is focusing on' },
  },
  async run(args) {
    const r = focusTimer.start(Number(args.minutes) || 25, String(args.task ?? ''));
    return { ok: true, endsInMin: r.endsInMin, task: r.task, note: `Focus started for ${r.endsInMin} minutes — I'll tell you when to take a break.` };
  },
});

registerTool({
  name: 'focus_status',
  description: 'Check the current focus/Deep Work session — how much time is left.',
  params: {},
  async run() { return focusTimer.status(); },
});

registerTool({
  name: 'extend_focus',
  description: 'Extend the running focus session — use when Mikkel is in flow and wants to keep going ("give me 10 more minutes", "keep going", "lidt mere").',
  params: { minutes: { type: 'number', description: 'minutes to add (default 10)' } },
  async run(args) {
    const r = focusTimer.extend(Number(args.minutes) || 10);
    return r.ok ? { ok: true, remainingMin: r.remainingMin } : { error: 'no focus session is running — use start_focus' };
  },
});

registerTool({
  name: 'end_focus',
  description: 'End or cancel the focus session early. Use when Mikkel says "stop the timer", "end focus", "afslut fokus".',
  params: {},
  async run() { const r = focusTimer.stop(); return { ok: true, wasActive: r.ok }; },
});
