import { registerTool } from '../registry.js';
import { fsIndex } from '@grace/core';

// Voice-configurable management of Grace's filesystem index roots.

registerTool({
  name: 'list_indexed_folders',
  description: 'List the folders Grace indexes for fast file lookup, and how many entries are indexed. Use when Mikkel asks what she searches or what she knows about his files.',
  params: {},
  async run() { return fsIndex.stats(); },
});

registerTool({
  name: 'add_indexed_folder',
  description: 'Add a folder to Grace\'s filesystem index so she can find files in it fast. Use when Mikkel asks Grace to index/watch/remember a folder, or when he keeps asking about files in a location she hasn\'t indexed — offer to add it. Whole drives are allowed (system/build junk is auto-skipped). Reindexes in the background.',
  params: {
    path: { type: 'string', description: 'absolute folder path to index (e.g. C:\\Users\\mikke\\Studie)', required: true },
  },
  async run(args) {
    const res = fsIndex.addRoot(String(args.path ?? ''));
    if (!res.ok) return { error: res.error };
    return { ok: true, added: String(args.path).trim(), roots: res.roots, note: 'Indexing in the background — searchable shortly.' };
  },
});

registerTool({
  name: 'remove_indexed_folder',
  description: 'Stop indexing a folder. Use when Mikkel asks Grace to forget or stop watching a folder.',
  params: {
    path: { type: 'string', description: 'the folder path to remove from the index', required: true },
  },
  async run(args) {
    const res = fsIndex.removeRoot(String(args.path ?? ''));
    return { ok: true, removed: res.removed, roots: res.roots };
  },
});

registerTool({
  name: 'reindex_files',
  description: 'Rebuild the filesystem index now (picks up new, moved, or deleted files). Use if file lookups seem stale or right after adding a lot of files.',
  params: {},
  async run() {
    const r = await fsIndex.reindex();
    return { ok: true, indexedEntries: r.count, ms: r.ms };
  },
});
