import { registerTool } from '../registry.js';

// Create a folder (and any missing parents) under the home folder.
registerTool({
  name: 'create_folder',
  description: 'Create a new folder (and any missing parent folders) at the given path. Gated to the home folder.',
  params: {
    path: { type: 'string', description: 'absolute path of the folder to create (under the home folder)', required: true },
  },
  async run(args) {
    const os = await import('os');
    const fs = await import('fs/promises');
    const path = await import('path');
    const home = path.resolve(os.homedir());
    const raw = String(args.path ?? '');
    if (!raw) return { error: 'path is required' };
    const p = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(home, raw);
    if (!p.startsWith(home)) return { error: `Refused: ${p} is outside your home folder (${home}). Only folders under home can be created.` };
    try {
      await fs.mkdir(p, { recursive: true });
      return { path: p, ok: true };
    } catch (e) { return { path: p, error: String(e) }; }
  },
});
