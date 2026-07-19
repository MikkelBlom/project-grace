import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { registerTool } from '../registry.js';

// Grep INSIDE files — find where text is written, not just filenames (that's find_file).
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', 'appdata', '.cache', 'target']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.py', '.html', '.css', '.scss', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.sh', '.ps1', '.bat', '.xml', '.csv', '.log', '.env', '.sql', '.go', '.rs', '.java', '.c', '.cpp', '.h']);

registerTool({
  name: 'search_content',
  description: 'Search INSIDE files for text (grep). Returns matching file paths with line numbers and the matching line. Use to find WHERE something is written; for filenames use find_file. Wrap the query in /slashes/ for a regex.',
  params: {
    query: { type: 'string', description: 'text to find, or /regex/ (add i for case-insensitive: /foo/i)', required: true },
    root: { type: 'string', description: 'folder to search recursively (default: your home folder)' },
    maxResults: { type: 'number', description: 'max matches (default 40, max 200)' },
  },
  async run(args) {
    const q = String(args.query ?? '').trim();
    if (!q) return { error: 'query is required' };
    const root = path.resolve(String(args.root ?? os.homedir()));
    if (!fs.existsSync(root)) return { error: `path does not exist: ${root}` };
    const max = Math.max(1, Math.min(200, Number(args.maxResults) || 40));

    let re: RegExp;
    const m = q.match(/^\/(.*)\/([a-z]*)$/);
    try {
      re = m ? new RegExp(m[1]!, m[2]) : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch { return { error: 'invalid regex' }; }

    const matches: Array<{ file: string; line: number; text: string }> = [];
    let filesScanned = 0;
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 8 || matches.length >= max) return;
      let ents: fs.Dirent[];
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (matches.length >= max) return;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')) await walk(path.join(dir, e.name), depth + 1);
          continue;
        }
        if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
        const full = path.join(dir, e.name);
        let st: fs.Stats;
        try { st = await fsp.stat(full); } catch { continue; }
        if (st.size > 2_000_000) continue; // skip huge files
        filesScanned++;
        let content: string;
        try { content = await fsp.readFile(full, 'utf8'); } catch { continue; }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < max; i++) {
          if (re.test(lines[i]!)) matches.push({ file: full, line: i + 1, text: lines[i]!.trim().slice(0, 200) });
        }
      }
    }
    await walk(root, 0);
    return { query: q, root, filesScanned, count: matches.length, matches };
  },
});
