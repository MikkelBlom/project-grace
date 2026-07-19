import { registerTool } from '../registry.js';
import { sttCorrections } from '@grace/core';

// Voice-teachable STT fixes: "when you hear X, I mean Y". Deterministic whole-word replacement
// applied to the transcript before Grace sees it — the safe alternative to acoustic hotword biasing.
registerTool({
  name: 'add_stt_correction',
  description: 'Teach Grace a permanent speech-to-text correction: whenever the mic hears "from", treat it as "to". Use when Mikkel says things like "when you hear X I mean Y" or "you keep mishearing X as Y" — best for names/technical terms that are consistently misheard. Confirm back what you saved.',
  params: {
    from: { type: 'string', description: 'the misheard word/phrase, spelled as speech-to-text writes it', required: true },
    to: { type: 'string', description: 'what it should be corrected to', required: true },
  },
  async run(args) {
    const from = String(args.from ?? '').trim();
    const to = String(args.to ?? '').trim();
    const res = sttCorrections.add(from, to);
    if (!res.ok) return { error: res.error };
    return { ok: true, saved: { from, to }, totalCorrections: res.count };
  },
});
