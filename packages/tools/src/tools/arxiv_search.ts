import { registerTool } from '../registry.js';
import { decodeEntities } from '../lib/web.js';

// arXiv preprint search. Queries the public Atom API and regex-parses each <entry> into a compact
// paper record. Sorted newest-first so "latest papers on X" returns fresh preprints. No deps.

function clean(s: string): string {
  return decodeEntities((s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function tagText(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? clean(m[1] ?? '') : '';
}

registerTool({
  name: 'arxiv_search',
  description: 'Search arXiv for recent research papers on a topic (CS, physics, math, stats, etc.). Returns the newest papers with title, authors, a short summary, and link. Use for "latest papers on X" or academic/preprint research.',
  params: {
    query: { type: 'string', description: 'search terms, e.g. "diffusion models" or "quantum error correction"', required: true },
    max_results: { type: 'number', description: 'how many papers to return (default 5, max 15)' },
  },
  async run(args) {
    const q = String(args.query ?? '').trim();
    if (!q) return { error: 'query is required' };
    const n = Math.max(1, Math.min(15, Number(args.max_results) || 5));
    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}`
      + `&max_results=${n}&sortBy=submittedDate&sortOrder=descending`;
    let xml: string;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { 'User-Agent': 'Grace/1.0 (local assistant)' } });
      if (!res.ok) return { query: q, error: `HTTP ${res.status}` };
      xml = await res.text();
    } catch (e) { return { query: q, error: String(e) }; }

    const papers = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => {
      const e = m[0];
      const authors = [...e.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
        .map((a) => clean(a[1] ?? '')).filter(Boolean);
      // Prefer the human-readable abstract page (rel="alternate"); fall back to any href, then <id>.
      let link = '';
      for (const l of [...e.matchAll(/<link\b[^>]*>/gi)].map((x) => x[0])) {
        const href = l.match(/href="([^"]+)"/i)?.[1];
        if (!href) continue;
        const rel = l.match(/rel="([^"]+)"/i)?.[1];
        if (!rel || rel === 'alternate') { link = decodeEntities(href); break; }
        if (!link) link = decodeEntities(href);
      }
      if (!link) link = tagText(e, 'id');
      let summary = tagText(e, 'summary');
      if (summary.length > 500) summary = summary.slice(0, 500).replace(/\s+\S*$/, '') + '…';
      return { title: tagText(e, 'title'), authors: authors.slice(0, 6), summary, link, published: tagText(e, 'published') };
    }).filter((p) => p.title);

    if (!papers.length) return { query: q, count: 0, papers: [], note: 'No papers found on arXiv for that query.' };
    return { query: q, count: papers.length, papers };
  },
});
