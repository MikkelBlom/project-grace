// ─────────────────────────────────────────────────────────────────────────────
// Filesystem index — so Grace knows where Mikkel's files and folders live.
//
// Walks a configurable set of ROOTS (config/index-roots.json), skipping system and
// build junk, and keeps a fast in-memory + on-disk index of every file/folder name →
// path. Whole-disk is allowed (add a drive root), bounded by maxEntries/maxDepth and a
// hard exclude list so it never wanders into Windows/Program Files/node_modules/etc.
//
// Voice-configurable: add_indexed_folder / remove_indexed_folder / list_indexed_folders /
// reindex_files tools call addRoot/removeRoot/build. Defaults seed Mikkel's usual folders.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CONFIG_PATH = path.join(ROOT, 'config', 'index-roots.json');
const CACHE_PATH = path.join(ROOT, 'data', 'fs-index.json');

// Never descend into these (matched case-insensitively by folder name) — system, cache, build junk.
const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.svn', '.hg', 'appdata', '$recycle.bin', 'windows', 'winnt',
  'program files', 'program files (x86)', 'programdata', 'system volume information',
  '.cache', '__pycache__', '.venv', 'venv', 'env', 'dist', 'build', 'out', '.next', '.nuxt',
  '.gradle', 'target', '.idea', '.vs', '.vscode', 'recovery', '$windows.~bt', '$windows.~ws',
  'perflogs', 'msocache', 'obj', 'bin', '.terraform', '.pnpm-store',
];

export interface FsEntry { path: string; name: string; dir: boolean; }
interface RootsConfig { roots: string[]; excludeDirs: string[]; maxEntries: number; maxDepth: number; }

function expandHome(p: string): string {
  const s = String(p ?? '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** Cheap subsequence test: are all chars of q present in n, in order? */
function subsequence(n: string, q: string): boolean {
  let i = 0;
  for (let j = 0; j < n.length && i < q.length; j++) if (n[j] === q[i]) i++;
  return i === q.length;
}

class FsIndex {
  private config: RootsConfig;
  private entries: FsEntry[] = [];
  private building = false;
  private builtAt = 0;
  private watchers: fs.FSWatcher[] = [];
  private watching = false;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private rebuildFirstScheduledAt = 0;

  constructor() {
    this.config = this.loadConfig();
    this.loadCache();
  }

  /** Called once at startup: build the index in the background, then watch the roots for changes. */
  async start(): Promise<void> {
    await this.build();
    this.watch();
  }

  private watch(): void {
    for (const w of this.watchers) { try { w.close(); } catch { /* already closed */ } }
    this.watchers = [];
    for (const rootRaw of this.config.roots) {
      const root = path.resolve(expandHome(rootRaw));
      if (!fs.existsSync(root)) continue;
      try {
        // Recursive watch is supported on Windows/macOS. persistent:false so it never keeps the
        // process alive. Debounced rebuild coalesces bursts (installs, git checkouts, downloads).
        const w = fs.watch(root, { recursive: true, persistent: false }, () => this.scheduleRebuild());
        this.watchers.push(w);
      } catch { /* recursive watch unsupported or dir too large — skip; reindex_files still works */ }
    }
    this.watching = true;
  }

  private scheduleRebuild(): void {
    const now = Date.now();
    if (!this.rebuildTimer) this.rebuildFirstScheduledAt = now;
    else clearTimeout(this.rebuildTimer);
    // Debounce 15s of quiet, but never postpone more than 90s under continuous file activity — else
    // the index stays stale during exactly the busy periods (every event resets the 15s timer).
    const delay = Math.min(15_000, Math.max(0, 90_000 - (now - this.rebuildFirstScheduledAt)));
    this.rebuildTimer = setTimeout(() => { this.rebuildTimer = null; this.rebuildFirstScheduledAt = 0; void this.build(); }, delay);
  }

  private defaultRoots(): string[] {
    const home = os.homedir();
    return ['Documents', 'Desktop', 'Downloads', path.join('Documents', 'Projects'), 'Wireframe Studios', 'Projects']
      .map((r) => path.join(home, r));
  }

  private loadConfig(): RootsConfig {
    let cfg: Partial<RootsConfig> = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first run */ }
    const roots = Array.isArray(cfg.roots) && cfg.roots.length ? cfg.roots.map(String) : this.defaultRoots();
    const config: RootsConfig = {
      roots,
      excludeDirs: (Array.isArray(cfg.excludeDirs) ? cfg.excludeDirs.map(String) : DEFAULT_EXCLUDES).map((s) => s.toLowerCase()),
      maxEntries: typeof cfg.maxEntries === 'number' ? cfg.maxEntries : 300_000,
      maxDepth: typeof cfg.maxDepth === 'number' ? cfg.maxDepth : 12,
    };
    if (!Array.isArray(cfg.roots)) this.saveConfig(config); // seed the file on first run
    return config;
  }

  private saveConfig(cfg: RootsConfig = this.config): void {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    } catch (e) { console.warn('[FsIndex] config save failed:', e); }
  }

  private loadCache(): void {
    try {
      const c = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      this.entries = Array.isArray(c.entries) ? c.entries : [];
      this.builtAt = Number(c.builtAt) || 0;
    } catch { this.entries = []; }
  }

  private saveCache(): void {
    try {
      fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
      fs.writeFileSync(CACHE_PATH, JSON.stringify({ builtAt: this.builtAt, count: this.entries.length, entries: this.entries }), 'utf8');
    } catch (e) { console.warn('[FsIndex] cache save failed:', e); }
  }

  private excluded(name: string): boolean {
    return name.startsWith('$') || this.config.excludeDirs.includes(name.toLowerCase());
  }

  /** Rebuild the whole index from the configured roots. Safe to call in the background. */
  async build(): Promise<{ count: number; ms: number }> {
    if (this.building) return { count: this.entries.length, ms: 0 };
    this.building = true;
    const start = Date.now();
    const out: FsEntry[] = [];
    const seen = new Set<string>();
    const walked: string[] = [];
    try {
      // Shallowest roots first so a nested root (e.g. Documents\Projects under Documents) is skipped
      // instead of re-walking the same files into duplicate entries.
      const roots = this.config.roots.map((r) => path.resolve(expandHome(r))).sort((a, b) => a.length - b.length);
      for (const root of roots) {
        const key = root.toLowerCase();
        if (seen.has(key) || !fs.existsSync(root)) continue;
        if (walked.some((w) => key === w || key.startsWith(w + path.sep))) continue; // descendant of an already-walked root
        seen.add(key);
        walked.push(key);
        await this.walk(root, 0, out);
        if (out.length >= this.config.maxEntries) break;
      }
      this.entries = out;
      this.builtAt = start;
      this.saveCache();
    } finally {
      this.building = false;
    }
    return { count: this.entries.length, ms: Date.now() - start };
  }

  private async walk(dir: string, depth: number, out: FsEntry[]): Promise<void> {
    if (depth > this.config.maxDepth || out.length >= this.config.maxEntries) return;
    let dirents: fs.Dirent[];
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      if (out.length >= this.config.maxEntries) return;
      const isDir = d.isDirectory();
      if (isDir && this.excluded(d.name)) continue;
      const full = path.join(dir, d.name);
      out.push({ path: full, name: d.name, dir: isDir });
      if (isDir) await this.walk(full, depth + 1, out);
    }
  }

  private ensureBuilt(): void {
    // Lazy background build on first use if we have no cache yet — never blocks a turn.
    if (!this.entries.length && !this.building && !this.builtAt) void this.build();
  }

  /** Fuzzy name search over the index. Ranks exact > prefix > substring > subsequence, favouring shallower paths. */
  search(query: string, limit = 15): { building: boolean; results: Array<FsEntry & { score: number }> } {
    this.ensureBuilt();
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return { building: this.building, results: [] };
    const scored: Array<FsEntry & { score: number }> = [];
    for (const e of this.entries) {
      const n = e.name.toLowerCase();
      let score: number;
      if (n === q) score = 100;
      else if (n.startsWith(q)) score = 72;
      else if (n.includes(q)) score = 48;
      else if (q.length >= 3 && subsequence(n, q)) score = 24;
      else continue;
      score -= Math.min(20, e.path.split(path.sep).length); // prefer shallower / closer-to-root
      if (e.dir) score += 2;
      scored.push({ ...e, score });
    }
    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
    return { building: this.building, results: scored.slice(0, limit) };
  }

  listRoots(): string[] { return [...this.config.roots]; }

  addRoot(p: string): { ok: boolean; error?: string; roots: string[] } {
    const abs = path.resolve(expandHome(p));
    if (!abs) return { ok: false, error: 'a path is required', roots: this.listRoots() };
    if (!fs.existsSync(abs)) return { ok: false, error: `path does not exist: ${abs}`, roots: this.listRoots() };
    const already = this.config.roots.some((r) => path.resolve(expandHome(r)).toLowerCase() === abs.toLowerCase());
    if (!already) {
      this.config.roots.push(abs);
      this.saveConfig();
      void this.build();
      if (this.watching) this.watch();
    }
    return { ok: true, roots: this.listRoots() };
  }

  removeRoot(p: string): { ok: boolean; removed: boolean; roots: string[] } {
    const abs = path.resolve(expandHome(p)).toLowerCase();
    const before = this.config.roots.length;
    this.config.roots = this.config.roots.filter((r) => path.resolve(expandHome(r)).toLowerCase() !== abs
      && r.toLowerCase() !== String(p ?? '').trim().toLowerCase());
    const removed = this.config.roots.length !== before;
    if (removed) { this.saveConfig(); void this.build(); if (this.watching) this.watch(); }
    return { ok: true, removed, roots: this.listRoots() };
  }

  async reindex(): Promise<{ count: number; ms: number }> { return this.build(); }

  stats(): { indexedEntries: number; roots: string[]; builtAt: number; building: boolean } {
    return { indexedEntries: this.entries.length, roots: this.listRoots(), builtAt: this.builtAt, building: this.building };
  }
}

export const fsIndex = new FsIndex();
