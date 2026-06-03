// ─────────────────────────────────────────────
// Grace — minimal tool framework + built-in tools
//
// Self-contained registry so Grace can call tools. Lives in the llm package
// for now; designed to be promoted to packages/tools (the self-expanding
// toolbox) later. The AI itself stays 100% local — some tools fetch public
// no-key APIs (weather/location/web) the same way any assistant looks things up.
//
// Protocol: Grace replies with ONE line of JSON {"tool":"name","args":{...}}.
// OllamaLLM detects it, runs the tool, then asks the model to answer with the result.
// ─────────────────────────────────────────────

export interface ToolSpec {
  name: string;
  description: string;
  params: Record<string, { type: string; description: string; required?: boolean }>;
  run(args: Record<string, any>): Promise<unknown>;
}

const tools = new Map<string, ToolSpec>();

export function registerTool(t: ToolSpec): void { tools.set(t.name, t); }
export function listTools(): ToolSpec[] { return [...tools.values()]; }

/** Catalog text injected into the system prompt so the model knows what it can call. */
export function describeTools(): string {
  if (tools.size === 0) return '';
  const lines = ['TOOLS you can call:'];
  for (const t of tools.values()) {
    const ps = Object.entries(t.params)
      .map(([k, v]) => `${k} (${v.type}${v.required ? ', required' : ''}): ${v.description}`)
      .join('; ');
    lines.push(`- ${t.name}: ${t.description}${ps ? ` | args: ${ps}` : ' | args: none'}`);
  }
  lines.push(
    '',
    'To use a tool, output ONLY this single line of JSON, with NOTHING before or after it:',
    '{"tool":"name","args":{...}}',
    'For anything needing live or local data — weather, your location, files on this PC — you MUST call the matching tool; never guess or refuse. After you receive the result, answer Mikkel briefly in English. For things you already know, just answer normally.',
  );
  return lines.join('\n');
}

export interface ToolInvocation { tool: string; args: Record<string, any>; }

/** Detect a tool-call JSON in the model's reply. Returns null for normal prose. */
export function parseToolCall(text: string): ToolInvocation | null {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  // Extract the first balanced {...} object, tolerating prose before/after it
  // (the model sometimes appends "I'll search..." after the JSON).
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    if (obj && typeof obj.tool === 'string') {
      return { tool: obj.tool, args: (obj.args && typeof obj.args === 'object') ? obj.args : {} };
    }
  } catch { /* not a tool call — normal reply */ }
  return null;
}

export async function runTool(name: string, args: Record<string, any>): Promise<unknown> {
  const t = tools.get(name);
  if (!t) return { error: `Unknown tool: ${name}` };
  try { return await t.run(args ?? {}); }
  catch (e) { return { error: String(e) }; }
}

// ── helpers ──────────────────────────────────────────────────────
async function fetchJson(url: string, timeoutMs = 8000): Promise<any> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'GraceAssistant/0.1' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── built-in tools ───────────────────────────────────────────────

// 1) Approx current location from this PC's public IP (no key).
registerTool({
  name: 'get_location',
  description: "Mikkel's approximate current location from the machine's IP (city, region, country, lat/lon).",
  params: {},
  async run() {
    const d = await fetchJson('http://ip-api.com/json/?fields=status,country,regionName,city,lat,lon');
    if (d.status !== 'success') throw new Error('could not determine location');
    return { city: d.city, region: d.regionName, country: d.country, lat: d.lat, lon: d.lon };
  },
});

// 2) Current local weather (Open-Meteo, no key). Uses IP location if lat/lon omitted.
registerTool({
  name: 'get_weather',
  description: 'Current weather. If lat/lon are omitted, the current IP location is used automatically.',
  params: {
    lat: { type: 'number', description: 'latitude (optional)' },
    lon: { type: 'number', description: 'longitude (optional)' },
  },
  async run(args) {
    let lat = args.lat, lon = args.lon, place = '';
    if (lat == null || lon == null) {
      const loc = await fetchJson('http://ip-api.com/json/?fields=status,city,lat,lon');
      lat = loc.lat; lon = loc.lon; place = loc.city ?? '';
    }
    const w = await fetchJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code',
    );
    const c = w.current ?? {};
    return {
      place,
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_pct: c.relative_humidity_2m,
      wind_kmh: c.wind_speed_10m,
      weather_code: c.weather_code,
    };
  },
});

// 3) Local file/folder search under a root (default: user's home dir).
registerTool({
  name: 'search_files',
  description: 'Search local FILES and FOLDERS whose name contains a query (live walk, no indexing). Empty query lists the top level of the root. Note: Danish folder names are usually English on disk (Downloads, Documents, Pictures, Desktop).',
  params: {
    query: { type: 'string', description: 'text the file/folder name should contain; empty = list the top level of root' },
    root: { type: 'string', description: "folder to search; a bare name resolves under home (e.g. 'Downloads'). Default = home folder." },
  },
  async run(args) {
    const os = await import('os');
    const fs = await import('fs/promises');
    const path = await import('path');
    const q = String(args.query ?? '').toLowerCase();
    let root = args.root ? String(args.root) : os.homedir();
    const rl = root.toLowerCase().trim();
    if (!args.root || rl === 'home' || rl === '~' || rl === '.' || rl === '') root = os.homedir();
    else if (!path.isAbsolute(root)) root = path.join(os.homedir(), root);
    const skip = new Set(['node_modules', '.git', 'AppData', '$Recycle.Bin', 'Windows', 'ProgramData', '.cache']);
    const hits: Array<{ path: string; type: 'file' | 'folder' }> = [];
    const maxHits = 30, maxVisited = 20000;
    let visited = 0;
    async function walk(dir: string, depth: number): Promise<void> {
      if (hits.length >= maxHits || visited > maxVisited || depth > 6) return;
      let entries: any[] = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (hits.length >= maxHits) return;
        visited++;
        const full = path.join(dir, e.name);
        const isDir = e.isDirectory();
        // Empty query => list the top level (depth 0). Otherwise match files AND folders by name.
        const match = q ? e.name.toLowerCase().includes(q) : depth === 0;
        if (match) hits.push({ path: full, type: isDir ? 'folder' : 'file' });
        if (isDir && !skip.has(e.name) && !e.name.startsWith('.')) await walk(full, depth + 1);
      }
    }
    try { await walk(root, 0); }
    catch (e) { return { root, error: String(e) }; }
    return { root, query: args.query ?? '', count: hits.length, matches: hits };
  },
});

// 4) Web search via DuckDuckGo HTML endpoint (no key) — real results with URLs.
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
