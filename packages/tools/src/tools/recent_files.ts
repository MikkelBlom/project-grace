import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { registerTool } from '../registry.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', 'appdata', '.cache', 'target', '$recycle.bin']);

// "What was I just working on?" — most-recently-modified files under a folder.
registerTool({
  name: 'recent_files',
  description: 'List the most recently modified files under a folder (default: Documents). Use when Mikkel asks what he was just working on, or for the latest file of a kind.',
  params: {
    root: { type: 'string', description: 'folder to scan (default: ~/Documents)' },
    limit: { type: 'number', description: 'how many to return (default 15, max 50)' },
    days: { type: 'number', description: 'only files modified within this many days (optional)' },
  },
  async run(args) {
    const root = path.resolve(String(args.root ?? path.join(os.homedir(), 'Documents')));
    if (!fs.existsSync(root)) return { error: `path does not exist: ${root}` };
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
    const cutoff = Number(args.days) > 0 ? Date.now() - Number(args.days) * 86_400_000 : 0;

    const found: Array<{ path: string; mtime: number }> = [];
    let scanned = 0;
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 6 || scanned > 40_000) return;
      let ents: fs.Dirent[];
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (scanned > 40_000) return;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')) await walk(path.join(dir, e.name), depth + 1);
          continue;
        }
        const full = path.join(dir, e.name);
        scanned++;
        try {
          const st = await fsp.stat(full);
          if (cutoff && st.mtimeMs < cutoff) continue;
          found.push({ path: full, mtime: st.mtimeMs });
        } catch { /* skip */ }
      }
    }
    await walk(root, 0);
    found.sort((a, b) => b.mtime - a.mtime);
    return {
      root,
      count: Math.min(found.length, limit),
      files: found.slice(0, limit).map((f) => ({ path: f.path, modified: new Date(f.mtime).toISOString() })),
    };
  },
});
