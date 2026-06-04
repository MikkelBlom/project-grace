import { registerTool } from '../registry.js';

// Recent tech/security news by composing web_search across a few queries.
// Demonstrates a tool calling another tool via ctx.callTool (see docs/adding-tools.md).
registerTool({
  name: 'news_fetcher',
  description: 'Get recent news headlines in software engineering, data breaches, and cyber attacks. Optionally pass a topic to focus the search.',
  params: {
    topic: { type: 'string', description: "optional topic to focus on, e.g. 'AI security'" },
  },
  async run(args, ctx) {
    const topic = typeof args.topic === 'string' && args.topic.trim() ? args.topic.trim() : '';
    const queries = topic
      ? [`recent ${topic} news`, `latest ${topic} security`]
      : ['recent software engineering news', 'latest data breaches', 'recent cyber attacks and hacks'];

    if (!ctx) return { error: 'no tool context (cannot call web_search)' };

    const headlines: string[] = [];
    let anySuccess = false;
    for (const query of queries) {
      const res = await ctx.callTool('web_search', { query }) as any;
      if (res && res.error) continue;
      anySuccess = true;
      const items = Array.isArray(res?.results) ? res.results : [];
      for (const r of items.slice(0, 4)) headlines.push(`- ${r.title} (${r.url})`);
    }
    if (!anySuccess) return { error: 'web_search was unavailable (no results).' };
    return { topic: topic || 'tech/security', headlines, note: headlines.length ? undefined : 'No headlines found.' };
  },
});
