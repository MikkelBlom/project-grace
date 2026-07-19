import { graceMemory } from '@grace/core';
import { registerTool } from '../registry.js';

const OLLAMA_URL = process.env.GRACE_OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.GRACE_LLM_MODEL ?? 'gemma4:26b';

// On-demand meeting / conversation summary — recap what was discussed, decided, and to-do.
registerTool({
  name: 'summarize_session',
  description: 'Summarize the recent conversation or meeting so far — what was discussed, what was decided, and any action items. Use when Mikkel asks for a recap, a meeting summary, or "what have we covered".',
  params: { turns: { type: 'number', description: 'how many recent turns to summarize (default 40)' } },
  async run(args) {
    const n = Math.max(4, Math.min(200, Number(args.turns) || 40));
    const turns = graceMemory.recentTurns(n);
    if (!turns.length) return { error: 'no conversation to summarize yet' };
    const transcript = turns.map((t: any) => `${t.role === 'grace' ? 'Grace' : 'Mikkel'}: ${t.content}`).join('\n');
    try {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          prompt: `Summarize this conversation for Mikkel. Cover: what was discussed, decisions made, and any action items / to-dos. Be concise and concrete.\n\n${transcript}\n\nSummary:`,
          stream: false, think: false, options: { temperature: 0.3 }, keep_alive: -1,
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) return { error: `Ollama HTTP ${res.status}` };
      const d = (await res.json()) as { response?: string };
      return { turnsSummarized: turns.length, summary: (d.response ?? '').trim() };
    } catch (e) { return { error: String(e) }; }
  },
});
