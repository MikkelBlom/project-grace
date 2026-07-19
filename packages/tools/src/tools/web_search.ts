import { registerTool } from '../registry.js';
import { searchWeb } from '../lib/web.js';

// Web search — SearXNG-first (local/private), DuckDuckGo fallback. Real results with URLs.
registerTool({
  name: 'web_search',
  description: 'Search the web for real, current results (title, URL, snippet). Prefers a local SearXNG instance and falls back to DuckDuckGo. Use for anything time-sensitive, local to now, or that you are not certain of — then fetch_url to read the best result. Returns {error} (not empty) if search is unavailable.',
  params: {
    query: { type: 'string', description: 'search query', required: true },
    limit: { type: 'number', description: 'max results to return (default 8, max 15)' },
  },
  async run(args) {
    const q = String(args.query ?? '').trim();
    if (!q) return { error: 'query is required' };
    const limit = Math.max(1, Math.min(15, Number(args.limit) || 8));
    const { provider, results, error } = await searchWeb(q, limit);
    if (!results.length) return { query: q, provider, count: 0, results: [], error: error ?? 'no results' };
    return { query: q, provider, count: results.length, results };
  },
});
