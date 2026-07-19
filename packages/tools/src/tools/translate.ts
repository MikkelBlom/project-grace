import { registerTool } from '../registry.js';

const OLLAMA_URL = process.env.GRACE_OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.GRACE_LLM_MODEL ?? 'gemma4:26b';

// Translate via the local LLM — handles Danish<->English and beyond, fully offline.
registerTool({
  name: 'translate',
  description: 'Translate text between languages (e.g. Danish <-> English). Use when Mikkel asks to translate something or wants a phrase in another language.',
  params: {
    text: { type: 'string', description: 'the text to translate', required: true },
    to: { type: 'string', description: 'target language, e.g. "English", "Danish", "German"', required: true },
  },
  async run(args) {
    const text = String(args.text ?? '').trim();
    const to = String(args.to ?? '').trim();
    if (!text || !to) return { error: 'text and to are required' };
    try {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          prompt: `Translate the following text into ${to}. Output ONLY the translation, no quotes or notes.\n\n${text}`,
          stream: false, think: false, options: { temperature: 0.2 }, keep_alive: -1,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return { error: `Ollama HTTP ${res.status}` };
      const d = (await res.json()) as { response?: string };
      return { to, translation: (d.response ?? '').trim() };
    } catch (e) { return { error: String(e) }; }
  },
});
