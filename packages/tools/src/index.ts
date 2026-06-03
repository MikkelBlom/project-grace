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
    // Fuzzy match: treat hyphens/underscores/extra spaces the same ("AI-automation" ~ "AI automation").
    const norm = (s: string) => s.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    const q = norm(String(args.query ?? ''));
    let root = args.root ? String(args.root) : os.homedir();
    const rl = root.toLowerCase().trim();
    if (!args.root || rl === 'home' || rl === '~' || rl === '.' || rl === '') root = os.homedir();
    else if (rl.startsWith('home/') || rl.startsWith('home\\')) root = path.join(os.homedir(), root.slice(5));
    else if (rl.startsWith('~/') || rl.startsWith('~\\')) root = path.join(os.homedir(), root.slice(2));
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
        const match = q ? norm(e.name).includes(q) : depth === 0;
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

// 5) Read a local file's text contents (optionally just the first N lines).
registerTool({
  name: 'read_file',
  description: 'Read the text contents of a local file (optionally only the first N lines). Pair with search_files: find the file, then pass its full absolute path here.',
  params: {
    path: { type: 'string', description: 'absolute path to the file', required: true },
    lines: { type: 'number', description: 'max lines to return (optional; default 40, max 200)' },
  },
  async run(args) {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const raw = String(args.path ?? '');
    if (!raw) throw new Error('path is required');
    const home = path.resolve(os.homedir());
    const p = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(home, raw);
    const n = Number(args.lines);
    const maxLines = args.lines != null && Number.isFinite(n) ? Math.max(1, Math.min(200, Math.floor(n))) : 40;
    let data: string;
    try { data = await fs.readFile(p, 'utf-8'); }
    catch (e) { return { path: p, error: String(e) }; }
    const all = data.split(/\r?\n/);
    return { path: p, totalLines: all.length, returned: Math.min(maxLines, all.length), text: all.slice(0, maxLines).join('\n') };
  },
});

// 6) Fetch a web page and return its readable text (full article, not just a snippet).
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

// 7) Create / write a text file (gated to the user's home folder for safety).
registerTool({
  name: 'write_file',
  description: 'Create or write a TEXT file on disk (notes, ideas, code, etc). Only allowed under the user home folder. Set append:true to add to an existing file instead of overwriting it.',
  params: {
    path: { type: 'string', description: 'absolute path of the file to write (must be under the home folder)', required: true },
    content: { type: 'string', description: 'the text content to write', required: true },
    append: { type: 'boolean', description: 'append instead of overwrite (optional, default false)' },
  },
  async run(args) {
    const os = await import('os');
    const fs = await import('fs/promises');
    const path = await import('path');
    const home = path.resolve(os.homedir());
    const raw = String(args.path ?? '');
    // Resolve relative paths under HOME (not the app's cwd): "Downloads/x.txt" => ~/Downloads/x.txt.
    const p = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(home, raw);
    if (!p.startsWith(home)) return { error: `Refused: ${p} is outside your home folder (${home}). Only files under home can be written.` };
    const content = String(args.content ?? '');
    try {
      await fs.mkdir(path.dirname(p), { recursive: true });
      if (args.append) await fs.appendFile(p, content, 'utf-8');
      else await fs.writeFile(p, content, 'utf-8');
      return { path: p, bytes: Buffer.byteLength(content, 'utf-8'), mode: args.append ? 'append' : 'overwrite', ok: true };
    } catch (e) { return { path: p, error: String(e) }; }
  },
});

// 8) Move / rename a file (so Grace relocates files instead of re-creating them).
registerTool({
  name: 'move_file',
  description: 'Move or RENAME a file. Both source and destination must be under the home folder. If the destination is an existing folder, the original filename is kept. Use this to relocate a file instead of recreating it.',
  params: {
    from: { type: 'string', description: 'current absolute path of the file', required: true },
    to: { type: 'string', description: 'destination absolute path, or a folder to move it into', required: true },
  },
  async run(args) {
    const os = await import('os');
    const fs = await import('fs/promises');
    const path = await import('path');
    const home = path.resolve(os.homedir());
    const underHome = (s: string) => { const r = String(s ?? ''); return r && (path.isAbsolute(r) ? path.resolve(r) : path.resolve(home, r)); };
    const from = underHome(args.from);
    let to = underHome(args.to);
    if (!from || !to) return { error: 'both from and to are required' };
    if (!from.startsWith(home) || !to.startsWith(home)) return { error: 'Both paths must be under the home folder.' };
    try {
      try { const st = await fs.stat(to); if (st.isDirectory()) to = path.join(to, path.basename(from)); } catch { /* to does not exist yet */ }
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      return { from, to, ok: true };
    } catch (e) { return { from, to, error: String(e) }; }
  },
});

// 9) Delete a local file (gated to the user's home folder for safety).
registerTool({
  name: 'delete_file',
  description: 'Delete a local file. Only allowed for files under the user home folder. Returns an error if the file does not exist, is a directory, or cannot be deleted.',
  params: {
    path: { type: 'string', description: 'absolute path of the file to delete (must be under the home folder)', required: true },
  },
  async run(args) {
    const os = await import('os');
    const fs = await import('fs/promises');
    const path = await import('path');
    const home = path.resolve(os.homedir());
    const raw = String(args.path ?? '');
    if (!raw) throw new Error('path is required');
    const p = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(home, raw);
    if (!p.startsWith(home)) return { error: `Refused: ${p} is outside your home folder (${home}). Only files under home can be deleted.` };
    try {
      const stats = await fs.stat(p);
      if (stats.isDirectory()) return { error: `Refused: ${p} is a directory. delete_file can only delete files.` };
      await fs.unlink(p);
      return { path: p, ok: true };
    } catch (e) { return { path: p, error: String(e) }; }
  },
});

// ── Background-task registry (for autonomous "I'll get back to you" work) ──
export interface TaskState {
  id: string; description: string; phase: string; log: string[];
  result?: string; done: boolean; failed?: boolean; startedAt: number;
}
class TaskRegistryImpl {
  current: TaskState | null = null;
  start(description: string): TaskState {
    this.current = { id: 'task-' + Date.now(), description, phase: 'planning', log: [], done: false, startedAt: Date.now() };
    return this.current;
  }
  update(phase: string): void { if (this.current && !this.current.done) this.current.phase = phase; }
  log(line: string): void { if (this.current) { this.current.log.push(line); if (this.current.log.length > 25) this.current.log.shift(); } }
  finish(result: string): void { if (this.current) { this.current.result = result; this.current.done = true; this.current.phase = 'done'; } }
  fail(err: string): void { if (this.current) { this.current.failed = true; this.current.done = true; this.current.phase = 'failed'; this.current.result = err; } }
  isRunning(): boolean { return !!this.current && !this.current.done; }
  status(): string {
    const t = this.current;
    if (!t) return 'No task is running and none has run yet.';
    const secs = Math.round((Date.now() - t.startedAt) / 1000);
    if (t.done) return t.failed ? `The last task failed: ${t.result}` : `That task is finished. Result: ${t.result}`;
    return `Still working on "${t.description}" — currently ${t.phase}, about ${secs} seconds in. Recently: ${t.log.slice(-2).join('; ') || 'getting started'}.`;
  }
}
export const TaskRegistry = new TaskRegistryImpl();

// Report progress of the running background task (so Mikkel can interrupt to ask).
registerTool({
  name: 'task_status',
  description: 'Report the progress of the background task you are currently working on. Use this whenever Mikkel asks how far along you are / what you are doing.',
  params: {},
  async run() { return { status: TaskRegistry.status() }; },
});

// Kick off a LONG autonomous task (intercepted by the LLM layer, which acks then works in the background).
registerTool({
  name: 'start_background_task',
  description: 'Start a LONG, multi-step task that you should work on autonomously in the background (e.g. "find X, dig through it and report", "research Y and summarise"). You will acknowledge immediately, then plan, execute and verify on your own, and report back when done. Do NOT use this for quick questions or single lookups.',
  params: { description: { type: 'string', description: 'a clear, self-contained description of the task to perform', required: true } },
  async run(args) { return { started: true, description: String((args && args.description) || '') }; },
});

// 9) Open a website/URL in the user's own default web browser.
registerTool({
  name: 'open_browser',
  description: "Open a website/URL in the user's default browser so they can view/browse it themselves. Returns { opened: true, url } or { error }.",
  params: {
    url: { type: 'string', description: 'The absolute http(s) URL to open in the browser', required: true },
  },
  async run(args) {
    const rawUrl = String(args.url ?? '').trim();
    if (!rawUrl) {
      return { error: 'URL is required' };
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return { error: 'Invalid URL protocol. Only http and https are allowed.' };
      }
    } catch {
      return { error: `Invalid URL format: "${rawUrl}"` };
    }

    const cleanUrl = parsedUrl.href;
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      const platform = process.platform;
      let cmd = '';
      if (platform === 'win32') {
        cmd = `cmd.exe /c start "" "${cleanUrl}"`;
      } else if (platform === 'darwin') {
        cmd = `open "${cleanUrl}"`;
      } else {
        cmd = `xdg-open "${cleanUrl}"`;
      }

      await execAsync(cmd, { timeout: 5000 });
      return { opened: true, url: cleanUrl };
    } catch (e) {
      return { error: `Failed to open browser: ${String(e)}` };
    }
  },
});

// 10) List contents of a folder.
registerTool({
  name: 'list_dir',
  description: 'List the immediate contents of a folder by absolute path. Use after search_files to look inside a folder.',
  params: {
    path: { type: 'string', description: 'absolute path to the folder', required: true },
  },
  async run(args) {
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs/promises');
    const home = path.resolve(os.homedir());
    const raw = String(args.path ?? '');
    if (!raw) throw new Error('path is required');
    const rl = raw.toLowerCase().trim();
    let p = raw;
    if (rl === 'home' || rl === '~' || rl === '.' || rl === '') {
      p = home;
    } else if (rl.startsWith('home/') || rl.startsWith('home\\')) {
      p = path.join(home, raw.slice(5));
    } else if (rl.startsWith('~/') || rl.startsWith('~\\')) {
      p = path.join(home, raw.slice(2));
    } else {
      p = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(home, raw);
    }
    try {
      const entries = await fs.readdir(p, { withFileTypes: true });
      return {
        path: p,
        items: entries.slice(0, 100).map(e => ({ name: e.name, type: e.isDirectory() ? 'folder' : 'file' })),
      };
    } catch (e) {
      return { path: p, error: String(e) };
    }

// Read the text content of the system clipboard.
registerTool({
  name: 'clipboard_read',
  description: 'Read the current text content of the system clipboard.',
  params: {},
  async run() {
    const { spawn } = await import('child_process');
    return new Promise((resolve) => {
      const ps = spawn('powershell.exe', [
        '-NoProfile',
        '-Command',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard'
      ]);
      let stdout = '';
      let stderr = '';
      ps.stdout.on('data', (data) => { stdout += data.toString(); });
      ps.stderr.on('data', (data) => { stderr += data.toString(); });
      ps.on('close', (code) => {
        if (code !== 0) {
          resolve({ error: `PowerShell exited with code ${code}: ${stderr.trim()}` });
        } else {
          resolve({ text: stdout.replace(/\r\n/g, '\n') });
        }
      });
      ps.on('error', (err) => {
        resolve({ error: String(err) });
      });
    });
  },
});

// Write text to the system clipboard.
registerTool({
  name: 'clipboard_write',
  description: 'Write text to the system clipboard.',
  params: {
    text: { type: 'string', description: 'the text to write to the clipboard', required: true },
  },
  async run(args) {
    const { spawn } = await import('child_process');
    const text = args.text == null ? '' : String(args.text);
    return new Promise((resolve) => {
      let command = '';
      if (!text) {
        command = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()';
      } else {
        command = '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $content = [Console]::In.ReadToEnd(); Set-Clipboard -Value $content';
      }
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command', command]);
      if (text) {
        ps.stdin.write(text, 'utf-8');
        ps.stdin.end();
      }
      let stderr = '';
      ps.stderr.on('data', (data) => { stderr += data.toString(); });
      ps.on('close', (code) => {
        if (code !== 0) {
          resolve({ error: `PowerShell exited with code ${code}: ${stderr.trim()}` });
        } else {
          resolve({ ok: true });
        }
      });
      ps.on('error', (err) => {
        resolve({ error: String(err) });
      });
    });
  },
});

// 11) Read the text content of the system clipboard.
registerTool({
  name: 'clipboard_read',
  description: 'Read the current text content of the system clipboard.',
  params: {},
  async run() {
    const { spawn } = await import('child_process');
    return new Promise((resolve) => {
      const ps = spawn('powershell.exe', [
        '-NoProfile',
        '-Command',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard'
      ]);
      let stdout = '';
      let stderr = '';
      ps.stdout.on('data', (data) => { stdout += data.toString(); });
      ps.stderr.on('data', (data) => { stderr += data.toString(); });
      ps.on('close', (code) => {
        if (code !== 0) {
          resolve({ error: `PowerShell exited with code ${code}: ${stderr.trim()}` });
        } else {
          resolve({ text: stdout.replace(/\r\n/g, '\n') });
        }
      });
      ps.on('error', (err) => {
        resolve({ error: String(err) });
      });
    });
  },
});

// 12) Write text to the system clipboard.
registerTool({
  name: 'clipboard_write',
  description: 'Write text to the system clipboard.',
  params: {
    text: { type: 'string', description: 'the text to write to the clipboard', required: true },
  },
  async run(args) {
    const { spawn } = await import('child_process');
    const text = args.text == null ? '' : String(args.text);
    return new Promise((resolve) => {
      let command = '';
      if (!text) {
        command = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()';
      } else {
        command = '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $content = [Console]::In.ReadToEnd(); Set-Clipboard -Value $content';
      }
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command', command]);
      if (text) {
        ps.stdin.write(text, 'utf-8');
        ps.stdin.end();
      }
      let stderr = '';
      ps.stderr.on('data', (data) => { stderr += data.toString(); });
      ps.on('close', (code) => {
        if (code !== 0) {
          resolve({ error: `PowerShell exited with code ${code}: ${stderr.trim()}` });
        } else {
          resolve({ ok: true });
        }
      });
      ps.on('error', (err) => {
        resolve({ error: String(err) });
      });
    });
  },
});

