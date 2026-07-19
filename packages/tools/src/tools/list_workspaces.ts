import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerTool } from '../registry.js';

// The built file lives at packages/tools/dist/tools/ → the repo root is four levels up. The old
// `new URL(import.meta.url).pathname` yielded a malformed /C:/… path on Windows and only went three
// levels up, so SCRATCHPAD_DIR pointed at packages/tools/data and this tool always returned [].
const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
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
