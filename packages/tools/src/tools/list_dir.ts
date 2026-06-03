import { registerTool } from '../registry.js';

// List contents of a folder.
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
  },
});
