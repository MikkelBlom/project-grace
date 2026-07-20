import { bus } from '@grace/core';
import { registerTool } from '../registry.js';

let narrationTimer: ReturnType<typeof setInterval> | null = null;

// Continuous screen narration (accessibility / hands-free) — Grace briefly describes the screen.
registerTool({
  name: 'start_screen_narration',
  description: 'Continuously narrate what is on screen every N seconds — Grace briefly says aloud what changed / what is shown. Use when Mikkel asks Grace to narrate or describe the screen while he does something else.',
  params: { seconds: { type: 'number', description: 'interval in seconds (default 15, min 5)' } },
  async run(args, ctx) {
    if (!ctx) return { error: 'screen narration needs tool context' };
    const sec = Math.max(5, Math.min(120, Number(args.seconds) || 15));
    if (narrationTimer) clearInterval(narrationTimer);
    narrationTimer = setInterval(async () => {
      try {
        const r = (await ctx.callTool('analyze_screen', { prompt: 'In one short sentence, what is currently shown on screen?' })) as any;
        const desc = r?.description || r?.text || r?.answer;
        if (desc && typeof desc === 'string') bus.emit('tts:speaking', { text: String(desc).slice(0, 240), sessionId: `narr-${Date.now()}` });
      } catch { /* skip this tick */ }
    }, sec * 1000);
    return { ok: true, intervalSeconds: sec, note: 'Narrating the screen. Call stop_screen_narration to stop.' };
  },
});

registerTool({
  name: 'stop_screen_narration',
  description: 'Stop the continuous screen narration.',
  params: {},
  async run() {
    if (narrationTimer) { clearInterval(narrationTimer); narrationTimer = null; return { ok: true, stopped: true }; }
    return { ok: true, stopped: false };
  },
});
