import { registerTool } from '../registry.js';

// Local file/folder search under a root (default: user's home dir).
registerTool({
  name: 'search_files',
  description: 'Search local FILES and FOLDERS whose name contains a query (live walk, no indexing). Empty query lists the top level of the root. Note: Danish folder names are usually English on disk (Downloads, Documents, Pictures, Desktop).',
  params: {
    query: { type: 'string', description: 'text the file/folder name should contain; empty = list the top level of root' },
    root: { type: 'string', description: "folder to search; a bare name resolves under home (e.g. 'Downloads'). Default = home folder." },
  },
  async run(args) {
    const os = await import('os');
    const fs = await import('fs/promises');
    const path = await import('path');
    // Fuzzy match: treat hyphens/underscores/extra spaces the same ("AI-automation" ~ "AI automation").
    const norm = (s: string) => s.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    const q = norm(String(args.query ?? ''));
    let root = args.root ? String(args.root) : os.homedir();
    const rl = root.toLowerCase().trim();
    if (!args.root || rl === 'home' || rl === '~' || rl === '.' || rl === '') root = os.homedir();
    else if (rl.startsWith('home/') || rl.startsWith('home\\')) root = path.join(os.homedir(), root.slice(5));
    else if (rl.startsWith('~/') || rl.startsWith('~\\')) root = path.join(os.homedir(), root.slice(2));
    else if (!path.isAbsolute(root)) root = path.join(os.homedir(), root);
    const skip = new Set(['node_modules', '.git', 'AppData', '$Recycle.Bin', 'Windows', 'ProgramData', '.cache']);
    const hits: Array<{ path: string; type: 'file' | 'folder' }> = [];
    const maxHits = 50, maxVisited = 20000;
    let visited = 0;
    
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length > 0 && hits.length < maxHits && visited < maxVisited) {
      const current = queue.shift()!;
      if (current.depth > 6) continue;
      
      let entries: any[] = [];
      try { entries = await fs.readdir(current.dir, { withFileTypes: true }); } catch { continue; }
      
      for (const e of entries) {
        if (hits.length >= maxHits) break;
        visited++;
        const full = path.join(current.dir, e.name);
        const isDir = e.isDirectory();
        
        // Empty query => list the top level (depth 0). Otherwise match files AND folders by name.
        const match = q ? norm(e.name).includes(q) : current.depth === 0;
        if (match) hits.push({ path: full, type: isDir ? 'folder' : 'file' });
        
        if (isDir && !skip.has(e.name) && !e.name.startsWith('.')) {
          queue.push({ dir: full, depth: current.depth + 1 });
        }
      }
    }
    return { root, query: args.query ?? '', count: hits.length, matches: hits };
  },
});
