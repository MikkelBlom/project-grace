import { registerTool } from '../registry.js';

// Move / rename a file (so Grace relocates files instead of re-creating them).
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
