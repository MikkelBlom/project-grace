import fs from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { registerTool } from '../registry.js';

const SKIP = new Set(['node_modules', '.git', '$recycle.bin', 'windows', 'appdata']);

// Find duplicate files (same content) so Mikkel can reclaim space. Size-bucket first, then hash.
registerTool({
  name: 'find_duplicates',
  description: 'Find duplicate files (identical content) under a folder, grouped so Mikkel can clean up. Use when he asks about duplicate files or reclaiming space.',
  params: {
    path: { type: 'string', description: 'folder to scan (default: ~/Downloads)' },
    minSizeKB: { type: 'number', description: 'ignore files smaller than this (default 100)' },
  },
  async run(args) {
    const root = path.resolve(String(args.path ?? path.join(os.homedir(), 'Downloads')));
    if (!fs.existsSync(root)) return { error: `path does not exist: ${root}` };
    const minSize = (Number(args.minSizeKB) || 100) * 1024;

    const bySize = new Map<number, string[]>();
    let scanned = 0;
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 8 || scanned > 100_000) return;
      let ents: fs.Dirent[];
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        scanned++;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP.has(e.name.toLowerCase()) && !e.name.startsWith('.')) await walk(full, depth + 1);
        } else {
          try {
            const st = await fsp.stat(full);
            if (st.size >= minSize) { const a = bySize.get(st.size) ?? []; a.push(full); bySize.set(st.size, a); }
          } catch { /* skip */ }
        }
      }
    }
    await walk(root, 0);

    const groups: Array<{ sizeMB: number; copies: string[] }> = [];
    for (const [size, files] of bySize) {
      if (files.length < 2) continue; // only same-size files can be duplicates
      const byHash = new Map<string, string[]>();
      for (const f of files) {
        try {
          const h = crypto.createHash('md5').update(await fsp.readFile(f)).digest('hex');
          const a = byHash.get(h) ?? []; a.push(f); byHash.set(h, a);
        } catch { /* skip */ }
      }
      for (const copies of byHash.values()) if (copies.length >= 2) groups.push({ sizeMB: +(size / 1e6).toFixed(2), copies });
    }
    groups.sort((a, b) => b.sizeMB - a.sizeMB);
    const wastedMB = +groups.reduce((m, g) => m + g.sizeMB * (g.copies.length - 1), 0).toFixed(1);
    return { root, duplicateGroups: groups.length, wastedMB, groups: groups.slice(0, 20) };
  },
});
