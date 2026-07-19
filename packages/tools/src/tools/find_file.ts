import { registerTool } from '../registry.js';
import { fsIndex } from '@grace/core';

// Fast fuzzy file/folder lookup over Grace's prebuilt filesystem index.
registerTool({
  name: 'find_file',
  description: 'Find a file or folder anywhere in Mikkel\'s indexed locations by name (fuzzy, fast — searches the prebuilt index, not the live disk). Use this FIRST to locate a file or folder before reading or opening it. If it finds nothing and Mikkel expects the file somewhere specific, offer add_indexed_folder for that location, or use search_files for a live scan.',
  params: {
    query: { type: 'string', description: 'file or folder name (or part of it) to find', required: true },
    limit: { type: 'number', description: 'max results (default 15, max 50)' },
  },
  async run(args) {
    const q = String(args.query ?? '').trim();
    if (!q) return { error: 'query is required' };
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
    const { building, results } = fsIndex.search(q, limit);
    if (!results.length) {
      const s = fsIndex.stats();
      return {
        query: q, count: 0, results: [], building,
        note: building
          ? 'The file index is still building — try again in a moment.'
          : `Nothing indexed matches "${q}" (${s.indexedEntries} entries indexed). If it lives in a folder Grace hasn't indexed, offer add_indexed_folder for that location, or use search_files for a live scan.`,
      };
    }
    return {
      query: q,
      count: results.length,
      results: results.map((r) => ({ path: r.path, name: r.name, type: r.dir ? 'folder' : 'file' })),
    };
  },
});
