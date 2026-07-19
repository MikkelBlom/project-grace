import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { registerTool } from '../registry.js';

const SKIP = new Set(['$recycle.bin', 'windows', 'system volume information']);

// "What's eating my disk?" — total size of a folder + its largest subfolders.
registerTool({
  name: 'disk_usage',
  description: 'Report the total size of a folder and its largest subfolders. Use when Mikkel asks what is taking up space somewhere.',
  params: {
    path: { type: 'string', description: 'folder to measure (default: your home folder)' },
    top: { type: 'number', description: 'how many largest subfolders to list (default 10)' },
  },
  async run(args) {
    const root = path.resolve(String(args.path ?? os.homedir()));
    if (!fs.existsSync(root)) return { error: `path does not exist: ${root}` };
    const top = Math.max(1, Math.min(30, Number(args.top) || 10));
    let scanned = 0;
    async function sizeOf(dir: string, depth: number): Promise<number> {
      if (depth > 10 || scanned > 400_000) return 0;
      let ents: fs.Dirent[];
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
      let total = 0;
      for (const e of ents) {
        scanned++;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP.has(e.name.toLowerCase())) continue;
          total += await sizeOf(full, depth + 1);
        } else {
          try { total += (await fsp.stat(full)).size; } catch { /* skip */ }
        }
      }
      return total;
    }

    let subs: fs.Dirent[];
    try { subs = (await fsp.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && !SKIP.has(e.name.toLowerCase())); }
    catch (e) { return { error: String(e) }; }
    const sizes = await Promise.all(subs.map(async (s) => ({ name: s.name, bytes: await sizeOf(path.join(root, s.name), 0) })));
    sizes.sort((a, b) => b.bytes - a.bytes);
    const totalBytes = sizes.reduce((m, s) => m + s.bytes, 0);
    return {
      root,
      totalGB: +(totalBytes / 1e9).toFixed(2),
      largest: sizes.slice(0, top).map((s) => ({ name: s.name, GB: +(s.bytes / 1e9).toFixed(2) })),
    };
  },
});
