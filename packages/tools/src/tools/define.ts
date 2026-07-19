import { registerTool } from '../registry.js';

// Real dictionary definitions (English) via the free dictionaryapi.dev.
registerTool({
  name: 'define',
  description: 'Look up the dictionary definition of an English word (part of speech + meaning + phonetics). For concepts, people, or other languages use wikipedia or research.',
  params: { word: { type: 'string', description: 'the English word to define', required: true } },
  async run(args) {
    const word = String(args.word ?? '').trim();
    if (!word) return { error: 'word is required' };
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) return { word, found: false, note: 'No dictionary entry — try wikipedia or research.' };
      if (!res.ok) return { word, error: `HTTP ${res.status}` };
      const data = (await res.json()) as any[];
      const entry = data?.[0];
      const definitions = (entry?.meanings ?? []).slice(0, 3).map((m: any) => ({
        partOfSpeech: m.partOfSpeech,
        definition: m.definitions?.[0]?.definition,
        example: m.definitions?.[0]?.example,
      }));
      return { word: entry?.word ?? word, found: true, phonetic: entry?.phonetic ?? '', definitions };
    } catch (e) { return { word, error: String(e) }; }
  },
});
