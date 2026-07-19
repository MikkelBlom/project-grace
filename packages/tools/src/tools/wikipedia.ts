import { registerTool } from '../registry.js';

// Focused encyclopedic lookups — faster + cleaner than a full web search for "who/what is X".
registerTool({
  name: 'wikipedia',
  description: 'Look up a concise Wikipedia summary for a topic, person, or place. Faster and cleaner than a full web search for encyclopedic facts. Falls back gracefully if there is no exact page (then use research).',
  params: {
    topic: { type: 'string', description: 'the thing to look up', required: true },
    lang: { type: 'string', description: 'wiki language: en (default) or da for Danish' },
  },
  async run(args) {
    const topic = String(args.topic ?? '').trim();
    if (!topic) return { error: 'topic is required' };
    const lang = /^(da|en|de|fr|es|no|sv)$/.test(String(args.lang ?? '')) ? String(args.lang) : 'en';
    try {
      const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic.replace(/ /g, '_'))}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Grace/1.0 (local assistant)', Accept: 'application/json' } });
      if (res.status === 404) return { topic, found: false, note: 'No exact Wikipedia page — try research or web_search.' };
      if (!res.ok) return { topic, error: `HTTP ${res.status}` };
      const d = (await res.json()) as { title?: string; extract?: string; content_urls?: { desktop?: { page?: string } } };
      return { topic: d.title ?? topic, found: true, summary: d.extract ?? '', url: d.content_urls?.desktop?.page ?? '' };
    } catch (e) { return { topic, error: String(e) }; }
  },
});
