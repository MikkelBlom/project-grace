import fs from 'fs';
import path from 'path';
import { registerTool } from '../registry.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const SCRATCHPAD_DIR = path.join(ROOT, 'data', 'scratchpads');

registerTool({
  name: 'list_workspaces',
  description: 'List persisted scratchpad workspaces (IDs).',
  params: {},
  async run() {
    try {
      const files = fs.existsSync(SCRATCHPAD_DIR) ? fs.readdirSync(SCRATCHPAD_DIR).filter(f => f.endsWith('.json')) : [];
      const ids = files.map(f => f.replace(/\.json$/, ''));
      return { ok: true, ids };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
});
