import fs from 'fs';
import os from 'os';
import path from 'path';
import { graceMemory } from '@grace/core';
import { registerTool } from '../registry.js';

registerTool({
  name: 'export_scratchpad',
  description: 'Export the active scratchpad as JSON or save to a specified path.',
  params: {
    path: { type: 'string', description: 'optional file path to write the JSON to' },
    pretty: { type: 'boolean', description: 'pretty-print JSON' },
  },
  async run(args) {
    const ws = graceMemory.getActiveWorkspace();
    if (!ws) return { ok: false, error: 'no active workspace' };
    const content = args.pretty ? JSON.stringify(ws, null, 2) : JSON.stringify(ws);
    if (typeof args.path === 'string' && args.path.trim()) {
      try {
        const p = path.resolve(String(args.path));
        // Gate writes to the user's home folder, like the other write tools — this used to accept
        // any absolute path.
        if (path.relative(os.homedir(), p).startsWith('..')) {
          return { ok: false, error: `Refusing to write outside your home folder (${os.homedir()}).` };
        }
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, 'utf-8');
        return { ok: true, path: p };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
    return { ok: true, content };
  },
});
