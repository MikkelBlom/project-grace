import { undoManager } from '@grace/core';
import { registerTool, isGraceOwnSource } from '../registry.js';

// Delete a local file (gated to the user's home folder for safety).
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
    if (isGraceOwnSource(p)) return { error: `Refused: ${p} is part of Grace's own source code — manage your own tools via create_tool, not raw delete_file.` };
    try {
      const stats = await fs.stat(p);
      if (stats.isDirectory()) return { error: `Refused: ${p} is a directory. delete_file can only delete files.` };
      undoManager.beforeDelete(p, `delete ${path.basename(p)}`);
      await fs.unlink(p);
      return { path: p, ok: true };
    } catch (e) { return { path: p, error: String(e) }; }
  },
});
