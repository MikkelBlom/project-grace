import { registerTool } from '../registry.js';

// Developer-docs lookup via MDN's public search API. Returns the top web-platform docs (HTML/CSS/JS/
// Web APIs) with title, absolute url, and summary. Non-web topics gracefully suggest research.

registerTool({
  name: 'docs_lookup',
  description: 'Look up web/developer documentation (HTML, CSS, JavaScript, Web APIs) via MDN. Returns the top matching docs with title, url, and summary. Use for "what does Array.flatMap do", "CSS grid docs", DOM/Web API references. Falls back to suggesting the research tool for non-web topics.',
  params: {
    query: { type: 'string', description: 'the API, method, or concept to look up, e.g. "fetch", "flexbox", "Array.reduce"', required: true },
    limit: { type: 'number', description: 'how many results (default 3, max 8)' },
  },
  async run(args) {
    const q = String(args.query ?? '').trim();
    if (!q) return { error: 'query is required' };
    const limit = Math.max(1, Math.min(8, Number(args.limit) || 3));
    try {
      const url = `https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(q)}&locale=en-US`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: { 'User-Agent': 'Grace/1.0 (local assistant)', Accept: 'application/json' },
      });
      if (!res.ok) return { query: q, error: `HTTP ${res.status}`, note: 'MDN lookup failed — try the research tool for a broader web answer.' };
      const data = (await res.json()) as { documents?: Array<{ title?: string; mdn_url?: string; summary?: string }> };
      const docs = Array.isArray(data.documents) ? data.documents : [];
      if (!docs.length) {
        return { query: q, count: 0, results: [], note: `No MDN docs for "${q}". This may not be a web-platform topic — use the research tool for a general answer.` };
      }
      const results = docs.slice(0, limit).map((d) => ({
        title: String(d.title ?? '').trim(),
        url: d.mdn_url ? `https://developer.mozilla.org${d.mdn_url}` : '',
        summary: String(d.summary ?? '').replace(/\s+/g, ' ').trim(),
      }));
      return { query: q, count: results.length, results };
    } catch (e) {
      return { query: q, error: String(e), note: 'MDN lookup failed — try the research tool for a general web answer.' };
    }
  },
});
