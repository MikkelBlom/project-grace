// ─────────────────────────────────────────────────────────────────────────────
// Shared web-retrieval helpers: search (SearXNG-first, DuckDuckGo fallback) and a
// real HTML→text extractor with full entity decoding. Used by web_search, fetch_url
// and news_fetcher so the whole assistant answers from ONE robust retrieval path.
//
// Design goals (these tools are the foundation of the retrieval-first harness):
//  - LOCAL by default: prefer a self-hosted SearXNG instance (GRACE_SEARCH_URL).
//  - NEVER fail silently: on a dead backend return a structured {error}, not [].
//  - Danish-safe: decode ø/å/æ/é and typographic entities so mixed da/en text reads.
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;    // which upstream engine produced it (SearXNG only)
  published?: string; // publish date when the backend supplies one
}

export interface SearchResponse {
  provider: string; // 'tavily' | 'brave' | 'searxng' | 'duckduckgo' | 'none'
  results: SearchResult[];
  error?: string;
}

// Local SearXNG by default. Point GRACE_SEARCH_URL at your instance; the JSON API must
// be enabled (search.formats includes `json` — see docker/searxng/config/settings.yml).
const SEARXNG_URL = (process.env.GRACE_SEARCH_URL ?? 'http://localhost:8888').replace(/\/+$/, '');

// ── HTML entity decoding ─────────────────────────────────────────────────────
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', aring: 'å', Aring: 'Å',
  eacute: 'é', Eacute: 'É', egrave: 'è', Egrave: 'È', agrave: 'à', ecirc: 'ê',
  ouml: 'ö', Ouml: 'Ö', auml: 'ä', Auml: 'Ä', uuml: 'ü', Uuml: 'Ü', szlig: 'ß',
  ndash: '–', mdash: '—', hellip: '…', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', deg: '°',
  euro: '€', pound: '£', cent: '¢', times: '×', divide: '÷',
};

/** Decode named + numeric (decimal and hex) HTML entities, including Danish letters. */
export function decodeEntities(input: string): string {
  if (!input) return '';
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Convert an HTML document to readable plain text. Removes scripts/styles and the
 * usual boilerplate containers (nav/header/footer/aside/form), turns block tags into
 * line breaks, strips remaining tags, decodes entities, and collapses whitespace.
 * Not a full Readability port, but a large step up from a naive tag-strip.
 */
export function htmlToText(html: string, maxChars = 6000): string {
  if (!html) return '';
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|article|section|blockquote|ul|ol|table|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(stripped)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return maxChars > 0 ? text.slice(0, maxChars) : text;
}

// ── Search providers ─────────────────────────────────────────────────────────
async function searxngSearch(query: string, limit: number): Promise<SearchResult[]> {
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/json', 'User-Agent': 'Grace/1.0 (local assistant)' },
  });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
  const rows = Array.isArray(data.results) ? data.results : [];
  return rows.slice(0, limit).map((r) => ({
    title: String(r.title ?? '').trim(),
    url: String(r.url ?? '').trim(),
    snippet: decodeEntities(String(r.content ?? '')).replace(/\s+/g, ' ').trim(),
    source: r.engine ? String(r.engine) : undefined,
    published: r.publishedDate ? String(r.publishedDate) : undefined,
  })).filter((r) => r.url);
}

async function duckduckgoSearch(query: string, limit: number): Promise<SearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    signal: AbortSignal.timeout(10_000),
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();
  const clean = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  const deUddg = (href: string) => {
    const m = href.match(/[?&]uddg=([^&]+)/);
    try { return m && m[1] ? decodeURIComponent(m[1]) : href; } catch { return href; }
  };
  const titleRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snipRe.exec(html)) !== null) snippets.push(clean(sm[1] ?? ''));
  const results: SearchResult[] = [];
  let tm: RegExpExecArray | null;
  let i = 0;
  while ((tm = titleRe.exec(html)) !== null && results.length < limit) {
    const url = deUddg(tm[1] ?? '');
    if (url) results.push({ title: clean(tm[2] ?? ''), url, snippet: snippets[i] ?? '' });
    i++;
  }
  return results;
}

// Optional keyed providers — used first when their API key is set (env). Both return the common shape.
async function tavilySearch(query: string, limit: number): Promise<SearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: process.env.GRACE_TAVILY_KEY, query, max_results: limit }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
  return (data.results ?? []).slice(0, limit).map((r) => ({
    title: String(r.title ?? '').trim(), url: String(r.url ?? '').trim(),
    snippet: String(r.content ?? '').replace(/\s+/g, ' ').trim(),
  })).filter((r) => r.url);
}

async function braveSearch(query: string, limit: number): Promise<SearchResult[]> {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.GRACE_BRAVE_KEY ?? '' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const data = (await res.json()) as { web?: { results?: Array<Record<string, unknown>> } };
  return (data.web?.results ?? []).slice(0, limit).map((r) => ({
    title: String(r.title ?? '').trim(), url: String(r.url ?? '').trim(),
    snippet: decodeEntities(String(r.description ?? '')).replace(/\s+/g, ' ').trim(),
  })).filter((r) => r.url);
}

/**
 * Search the web through a provider registry: keyed APIs first when configured (Tavily, Brave),
 * then a local SearXNG instance (private), then DuckDuckGo. Returns a structured error rather than
 * an empty array when everything is unavailable — so the caller/model can react instead of mistaking
 * "backend down" for "no results".
 */
export async function searchWeb(query: string, limit = 8): Promise<SearchResponse> {
  const q = query.trim();
  if (!q) return { provider: 'none', results: [], error: 'empty query' };

  const providers: Array<[string, () => Promise<SearchResult[]>]> = [];
  if (process.env.GRACE_TAVILY_KEY) providers.push(['tavily', () => tavilySearch(q, limit)]);
  if (process.env.GRACE_BRAVE_KEY) providers.push(['brave', () => braveSearch(q, limit)]);
  providers.push(['searxng', () => searxngSearch(q, limit)]);
  providers.push(['duckduckgo', () => duckduckgoSearch(q, limit)]);

  let lastErr = '';
  for (const [name, fn] of providers) {
    try {
      const results = await fn();
      if (results.length) return { provider: name, results };
    } catch (e) { lastErr = String(e).slice(0, 120); }
  }
  return { provider: 'none', results: [], error: `Search unavailable (tried ${providers.map((p) => p[0]).join(', ')}). ${lastErr}` };
}
