import { registerTool } from '../registry.js';

// Web search via DuckDuckGo HTML endpoint (no key) — real results with URLs.
registerTool({
  name: 'web_search',
  description: 'Search the web for real results (title, URL, snippet) via DuckDuckGo. Use for current facts or anything you do not already know.',
  params: { query: { type: 'string', description: 'search query', required: true } },
  async run(args) {
    const q = String(args.query ?? '');
    if (!q) throw new Error('query is required');
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(10000),
      // DuckDuckGo refuses non-browser User-Agents (that was the old "fetch failed").
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const strip = (s: string) => s
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/')
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim();
    const deUddg = (href: string) => {
      const m = href.match(/[?&]uddg=([^&]+)/);
      try { return m && m[1] ? decodeURIComponent(m[1]) : href; } catch { return href; }
    };
    const titleRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const snippets: string[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = snipRe.exec(html)) !== null) snippets.push(strip(sm[1] ?? ''));
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    let tm: RegExpExecArray | null, i = 0;
    while ((tm = titleRe.exec(html)) !== null && results.length < 4) {
      results.push({ title: strip(tm[2] ?? ''), url: deUddg(tm[1] ?? ''), snippet: snippets[i] ?? '' });
      i++;
    }
    return { query: q, count: results.length, results };
  },
});
