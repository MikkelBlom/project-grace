import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { registerTool } from '../registry.js';

interface ProjectEntry {
  name: string;
  path: string;
  type: 'git' | 'npm' | 'both';
  mtime: number;
}

// Packages/tools/dist/tools is 4 levels deep from repo root
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SPATIAL_MAP_PATH = path.join(ROOT, 'data', 'spatial-map.json');

registerTool({
  name: 'find_path',
  description: 'Fuzzy-search the cached spatial map to locate project folder paths matching a query name (e.g. "grace", "budget"). Falls back to scans if needed.',
  params: {
    query: { type: 'string', description: 'Name or partial name of the project folder to find', required: true },
    limit: { type: 'number', description: 'Maximum number of results to return (default: 5)' },
  },
  async run(args) {
    const query = String(args.query ?? '').trim().toLowerCase();
    if (!query) return { error: 'query is required' };
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(20, args.limit)) : 5;

    if (!fs.existsSync(SPATIAL_MAP_PATH)) {
      return {
        ok: false,
        error: 'Spatial map does not exist. Call index_projects first to index your home folder.',
      };
    }

    let projects: ProjectEntry[] = [];
    try {
      projects = JSON.parse(fs.readFileSync(SPATIAL_MAP_PATH, 'utf-8'));
    } catch (e) {
      return { ok: false, error: `Failed to read spatial map: ${String(e)}` };
    }

    const hits = projects
      .map(p => {
        const nameLower = p.name.toLowerCase();
        let score = 0;

        // Exact match
        if (nameLower === query) score = 100;
        // Prefix match
        else if (nameLower.startsWith(query)) score = 80;
        // Substring match
        else if (nameLower.includes(query)) score = 50;
        // Substring match in absolute path
        else if (p.path.toLowerCase().includes(query)) score = 20;

        return { project: p, score };
      })
      .filter(hit => hit.score > 0)
      // Rank by matching score first, then by recency (mtime)
      .sort((a, b) => b.score - a.score || b.project.mtime - a.project.mtime)
      .slice(0, limit)
      .map(hit => ({
        name: hit.project.name,
        path: hit.project.path,
        type: hit.project.type,
        score: hit.score,
      }));

    return {
      ok: true,
      query,
      count: hits.length,
      hits,
    };
  },
});
