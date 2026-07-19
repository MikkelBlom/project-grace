import { registerTool } from '../registry.js';
import { htmlToText, decodeEntities } from '../lib/web.js';

// Fetch a web page and return its readable text (boilerplate removed, entities decoded).
registerTool({
  name: 'fetch_url',
  description: 'Open a web page and read its actual text content (strips scripts, nav/footer boilerplate, decodes entities incl. Danish letters). Use after web_search to read the full article at a result URL before answering.',
  params: {
    url: { type: 'string', description: 'the http(s) URL to fetch', required: true },
    maxChars: { type: 'number', description: 'max characters of text to return (optional; default 6000, max 20000)' },
  },
  async run(args) {
    const url = String(args.url ?? '');
    if (!/^https?:\/\//i.test(url)) return { error: 'a valid http(s) url is required' };
    const n = Number(args.maxChars);
    const cap = args.maxChars != null && Number.isFinite(n) ? Math.max(200, Math.min(20000, Math.floor(n))) : 6000;
    let res: Response;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'da,en;q=0.8' },
      });
    } catch (e) { return { url, error: String(e) }; }
    if (!res.ok) return { url, error: `HTTP ${res.status}` };
    const html = await res.text();
    const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
    const text = htmlToText(html, cap);
    return { url, title, chars: text.length, text };
  },
});
