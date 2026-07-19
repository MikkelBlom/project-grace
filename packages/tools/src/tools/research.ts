import { registerTool } from '../registry.js';

// research — the grounded-answer path. Instead of answering a factual question from the model's
// (frozen, sometimes wrong) memory, this searches the web, READS the top pages, and hands back a
// numbered, source-tagged digest. The model then writes its spoken answer FROM these sources and
// flags anything unsupported as a best guess. This is the core of the retrieval-first harness.

interface Source {
  n: number;
  title: string;
  url: string;
  published?: string;
  snippet: string;
  excerpt: string;
}

registerTool({
  name: 'research',
  description: 'Answer a question from LIVE web sources instead of memory. Runs web_search, reads the top pages, and returns a numbered digest of sources with excerpts. Use for anything time-sensitive, factual, or that you are not fully certain of. Then base your spoken answer ONLY on the returned sources, cite them, and mark anything unsupported as a best guess. Prefer this over guessing from memory for real-world facts.',
  params: {
    question: { type: 'string', description: 'the question to research, in natural language', required: true },
    queries: { type: 'string', description: 'optional comma-separated alternative search queries to broaden coverage' },
    read: { type: 'number', description: 'how many of the top pages to read in full (default 3, max 5)' },
  },
  async run(args, ctx) {
    if (!ctx) return { error: 'research needs tool context (call it as a normal tool)' };
    const question = String(args.question ?? '').trim();
    if (!question) return { error: 'question is required' };
    const read = Math.max(1, Math.min(5, Number(args.read) || 3));

    const queries = [question, ...String(args.queries ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean)].slice(0, 4);

    // 1) Search across the queries, de-duplicating result URLs.
    const seen = new Set<string>();
    const hits: Array<{ title: string; url: string; snippet: string; published?: string }> = [];
    let provider = 'none';
    const errors: string[] = [];
    for (const q of queries) {
      const r = (await ctx.callTool('web_search', { query: q, limit: 8 })) as any;
      if (r?.provider) provider = r.provider;
      if (r?.error && !(r?.results?.length)) { errors.push(String(r.error)); continue; }
      for (const res of (r?.results ?? [])) {
        const url = String(res.url ?? '');
        if (!url || seen.has(url)) continue;
        seen.add(url);
        hits.push({ title: String(res.title ?? ''), url, snippet: String(res.snippet ?? ''), published: res.published });
      }
    }

    if (!hits.length) {
      return {
        question, provider, sources: [], errors,
        note: 'No web results found. Do NOT fabricate an answer — tell Mikkel you could not find it. Only answer if you are genuinely certain from your own knowledge, and say it is not web-verified.',
      };
    }

    // 2) Read the top `read` pages in full; keep the rest as snippet-only for breadth.
    const sources: Source[] = [];
    for (let i = 0; i < Math.min(read, hits.length); i++) {
      const h = hits[i]!;
      const page = (await ctx.callTool('fetch_url', { url: h.url, maxChars: 4000 })) as any;
      sources.push({
        n: i + 1,
        title: h.title || String(page?.title ?? ''),
        url: h.url,
        published: h.published,
        snippet: h.snippet,
        excerpt: page?.error ? `(could not read page: ${page.error})` : String(page?.text ?? '').slice(0, 4000),
      });
    }
    for (let i = read; i < Math.min(hits.length, read + 4); i++) {
      const h = hits[i]!;
      sources.push({ n: i + 1, title: h.title, url: h.url, published: h.published, snippet: h.snippet, excerpt: '' });
    }

    return {
      question,
      provider,
      sourceCount: sources.length,
      sources,
      note: 'Answer Mikkel using ONLY these sources. Cite by number/title. If sources disagree, or do not cover part of the question, say so and mark that part as a best guess — do not fill gaps with assumptions.',
    };
  },
});
