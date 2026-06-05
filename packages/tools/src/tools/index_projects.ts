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

// Blacklisted directory names to avoid crawling dependency folders or system settings
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'bin',
  'obj',
  'out',
  'appdata',
  'application data',
  'local settings',
  'temp',
  'cache',
  'microsoft',
  'system32',
  'program files',
  'program files (x86)',
  'public',
  'all users',
  'default',
  'default user',
  'templates',
  'cookies',
  'nethood',
  'printhood',
  'recent',
  'sendto',
  'start menu',
  'my documents',
]);

function scanDir(dir: string, depth: number, maxDepth: number, results: ProjectEntry[]) {
  if (depth > maxDepth) return;
  let files: fs.Dirent[] = [];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // Ignore directories we can't read
  }

  let isGit = false;
  let isNpm = false;

  // First pass: check if the current directory itself is a project
  for (const file of files) {
    if (file.isDirectory() && file.name === '.git') {
      isGit = true;
    }
    if (file.isFile() && file.name === 'package.json') {
      isNpm = true;
    }
  }

  if (isGit || isNpm) {
    try {
      const stats = fs.statSync(dir);
      results.push({
        name: path.basename(dir),
        path: dir,
        type: isGit && isNpm ? 'both' : isGit ? 'git' : 'npm',
        mtime: stats.mtimeMs,
      });
    } catch {
      // Ignore if stat fails
    }
    // If it's a project, don't recurse deeper by default to avoid finding subprojects inside git repos
    return;
  }

  // Second pass: recurse into subdirectories
  for (const file of files) {
    if (file.isDirectory()) {
      const nameLower = file.name.toLowerCase();
      if (IGNORE_DIRS.has(nameLower) || nameLower.startsWith('.') || nameLower.startsWith('$')) {
        continue;
      }
      scanDir(path.join(dir, file.name), depth + 1, maxDepth, results);
    }
  }
}

registerTool({
  name: 'index_projects',
  description: 'Scan user folders under the home directory (Desktop, Documents, Downloads, Projects, etc.) to index project directories containing .git or package.json. Caches the map for spatial searches.',
  params: {
    maxDepth: { type: 'number', description: 'Maximum depth to scan (default: 5)' },
  },
  async run(args) {
    const maxDepth = typeof args.maxDepth === 'number' ? Math.max(1, Math.min(8, args.maxDepth)) : 5;
    const home = os.homedir();
    const results: ProjectEntry[] = [];

    // Root directories directly under the home folder to scan
    const scanTargets = [
      path.join(home, 'Desktop'),
      path.join(home, 'Documents'),
      path.join(home, 'Downloads'),
      path.join(home, 'Projects'),
      path.join(home, 'GitHub'),
      path.join(home, 'Source'),
    ].filter(dir => fs.existsSync(dir));

    // Also scan the home folder itself at depth 1 (non-recursively) for immediate projects
    try {
      const homeFiles = fs.readdirSync(home, { withFileTypes: true });
      for (const file of homeFiles) {
        if (file.isDirectory()) {
          const nameLower = file.name.toLowerCase();
          if (IGNORE_DIRS.has(nameLower) || nameLower.startsWith('.') || nameLower.startsWith('$')) {
            continue;
          }
          const fullPath = path.join(home, file.name);
          // Check if this subfolder is a project root directly
          let isGit = false;
          let isNpm = false;
          try {
            const subFiles = fs.readdirSync(fullPath);
            isGit = subFiles.includes('.git');
            isNpm = subFiles.includes('package.json');
          } catch {
            // Can't read, skip
          }
          if (isGit || isNpm) {
            results.push({
              name: file.name,
              path: fullPath,
              type: isGit && isNpm ? 'both' : isGit ? 'git' : 'npm',
              mtime: fs.statSync(fullPath).mtimeMs,
            });
          }
        }
      }
    } catch {
      // Ignore home dir readdir failure
    }

    // Scan target directories
    for (const target of scanTargets) {
      scanDir(target, 1, maxDepth, results);
    }

    try {
      fs.mkdirSync(path.dirname(SPATIAL_MAP_PATH), { recursive: true });
      fs.writeFileSync(SPATIAL_MAP_PATH, JSON.stringify(results, null, 2), 'utf-8');
      return {
        ok: true,
        count: results.length,
        projects: results.map(p => ({ name: p.name, path: p.path, type: p.type })),
        message: `Indexed ${results.length} project folders under home. Cached spatial map to ${SPATIAL_MAP_PATH}`,
      };
    } catch (e) {
      return { ok: false, error: `Failed to save spatial map: ${String(e)}` };
    }
  },
});
