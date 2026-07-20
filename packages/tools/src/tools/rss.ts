import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerTool } from '../registry.js';
import { decodeEntities } from '../lib/web.js';

// RSS/Atom reading. Three tools: rss_digest (fetch + merge newest items across saved or ad-hoc
// feeds), add_feed, list_feeds. Feeds persist in data/feeds.json. Parsing is regex-only (no deps):
// handles both RSS <item> and Atom <entry>, CDATA, and Atom's <link href="..."/> attribute form.

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const FEEDS_PATH = path.join(ROOT, 'data', 'feeds.json');

interface FeedItem { feed: string; title: string; link: string; published?: string; ts: number; }

function loadFeeds(): string[] {
  try {
    const d = JSON.parse(fs.readFileSync(FEEDS_PATH, 'utf8'));
    if (Array.isArray(d)) return d.map(String);
    return Array.isArray(d.feeds) ? d.feeds.map(String) : [];
  } catch { return []; }
}
function saveFeeds(feeds: string[]): void {
  fs.mkdirSync(path.dirname(FEEDS_PATH), { recursive: true });
  fs.writeFileSync(FEEDS_PATH, JSON.stringify({ feeds }, null, 2), 'utf8');
}

// Strip CDATA + inner tags, decode entities, collapse whitespace.
function clean(s: string): string {
  return decodeEntities(
    (s ?? '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

function tagText(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? clean(m[1] ?? '') : undefined;
}

// RSS uses <link>url</link>; Atom uses <link href="..." rel="alternate"/>. Prefer the human page.
function extractLink(block: string): string {
  const rss = block.match(/<link>([\s\S]*?)<\/link>/i);
  if (rss && rss[1] && rss[1].trim() && !/^\s*</.test(rss[1])) return clean(rss[1]);
  let fallback = '';
  for (const l of [...block.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0])) {
    const href = l.match(/href="([^"]+)"/i)?.[1];
    if (!href) continue;
    const rel = l.match(/rel="([^"]+)"/i)?.[1];
    if (!rel || rel === 'alternate') return decodeEntities(href);
    if (!fallback) fallback = decodeEntities(href);
  }
  return fallback;
}

function parseFeed(xml: string, feedUrl: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const m of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const b = m[0];
    const title = tagText(b, 'title') ?? '(untitled)';
    const link = extractLink(b);
    const published = tagText(b, 'pubDate') ?? tagText(b, 'published') ?? tagText(b, 'updated') ?? tagText(b, 'dc:date');
    const parsed = published ? Date.parse(published) : NaN;
    items.push({ feed: feedUrl, title, link, published, ts: Number.isFinite(parsed) ? parsed : 0 });
  }
  return items;
}

async function fetchFeed(url: string): Promise<{ url: string; items?: FeedItem[]; error?: string }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        'User-Agent': 'Grace/1.0 (local assistant)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) return { url, error: `HTTP ${res.status}` };
    return { url, items: parseFeed(await res.text(), url) };
  } catch (e) { return { url, error: String(e) }; }
}

registerTool({
  name: 'rss_digest',
  description: 'Fetch recent items from RSS/Atom feeds and return the newest headlines across them. Reads saved feeds from data/feeds.json unless you pass an explicit comma-separated list of feed URLs. Use for "what\'s new on my feeds", blog/news roundups.',
  params: {
    urls: { type: 'string', description: 'optional comma-separated feed URLs to use instead of the saved list' },
    limit: { type: 'number', description: 'max items to return across all feeds (default 15, max 40)' },
  },
  async run(args) {
    const explicit = String(args.urls ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const feeds = explicit.length ? explicit : loadFeeds();
    if (!feeds.length) return { items: [], note: 'No feeds configured. Add one with add_feed, or pass a urls list.' };
    const limit = Math.max(1, Math.min(40, Number(args.limit) || 15));
    const results = await Promise.all(feeds.slice(0, 20).map(fetchFeed));
    const all: FeedItem[] = [];
    const errors: string[] = [];
    for (const r of results) {
      if (r.error) { errors.push(`${r.url}: ${r.error}`); continue; }
      all.push(...(r.items ?? []));
    }
    all.sort((a, b) => b.ts - a.ts);
    const items = all.slice(0, limit).map((i) => ({ title: i.title, link: i.link, published: i.published, feed: i.feed }));
    return {
      feedCount: feeds.length,
      count: items.length,
      items,
      errors: errors.length ? errors : undefined,
      note: items.length ? undefined : 'No items parsed from the feeds.',
    };
  },
});

registerTool({
  name: 'add_feed',
  description: "Add an RSS/Atom feed URL to Mikkel's saved feed list (data/feeds.json) for later use by rss_digest.",
  params: { url: { type: 'string', description: 'the feed URL to add', required: true } },
  async run(args) {
    const url = String(args.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) return { error: 'a valid http(s) feed url is required' };
    const feeds = loadFeeds();
    if (feeds.includes(url)) return { ok: true, already: true, count: feeds.length };
    feeds.push(url);
    try { saveFeeds(feeds); } catch (e) { return { error: String(e) }; }
    return { ok: true, added: url, count: feeds.length };
  },
});

registerTool({
  name: 'list_feeds',
  description: 'List the saved RSS/Atom feed URLs (from data/feeds.json).',
  params: {},
  async run() {
    const feeds = loadFeeds();
    return { count: feeds.length, feeds };
  },
});
