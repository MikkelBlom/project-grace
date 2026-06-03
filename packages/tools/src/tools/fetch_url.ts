import { registerTool } from '../registry.js';

// Fetch a web page and return its readable text (full article, not just a snippet).
registerTool({
  name: 'fetch_url',
  description: 'Open a web page and read its actual text content (strips HTML/scripts). Use after web_search to read the full article at a result URL.',
  params: {
    url: { type: 'string', description: 'the http(s) URL to fetch', required: true },
    maxChars: { type: 'number', description: 'max characters of text to return (optional; default 4000, max 20000)' },
  },
  async run(args) {
    const url = String(args.url ?? '');
    if (!/^https?:\/\//i.test(url)) throw new Error('a valid http(s) url is required');
    const n = Number(args.maxChars);
    const cap = args.maxChars != null && Number.isFinite(n) ? Math.max(200, Math.min(20000, Math.floor(n))) : 4000;
    let res: Response;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'da,en;q=0.8' },
      });
    } catch (e) { return { url, error: String(e) }; }
    if (!res.ok) return { url, error: `HTTP ${res.status}` };
    const html = await res.text();
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|h[1-6]|br|tr|article|section)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&aelig;/gi, 'æ')
      .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
    return { url, title, chars: text.length, text: text.slice(0, cap) };
  },
});
