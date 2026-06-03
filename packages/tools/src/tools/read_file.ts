import { registerTool } from '../registry.js';

// Read a local file's text contents (optionally just the first N lines).
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
