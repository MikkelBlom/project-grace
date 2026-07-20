import { undoManager } from '@grace/core';
import { registerTool, isGraceOwnSource } from '../registry.js';

// Create / write a text file (gated to the user's home folder for safety).
registerTool({
  name: 'write_file',
  description: 'Write entirely new files or append/prepend to files. WARNING: DO NOT use this tool (mode="overwrite") to modify or clean up existing large text files or code files. You will struggle with JSON escaping and destroy the file. ALWAYS use the "edit_file" tool with "multi_replace" mode instead to modify existing files.',
  params: {
    path: { type: 'string', description: 'absolute path of the file to write (must be under the home folder)', required: true },
    content: { type: 'string', description: 'the text content to write', required: true },
    mode: { type: 'string', description: '"overwrite" (default: DELETES existing content), "append" (adds to bottom), or "prepend" (adds to top)' },
  },
  async run(args) {
    const os = await import('os');
    const fs = await import('fs/promises');
    const path = await import('path');
    const home = path.resolve(os.homedir());
    const raw = String(args.path ?? '');
    // Resolve relative paths under HOME (not the app's cwd): "Downloads/x.txt" => ~/Downloads/x.txt.
    const p = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(home, raw);
    if (!(p === home || p.startsWith(home + path.sep))) return { error: `Refused: ${p} is outside your home folder (${home}). Only files under home can be written.` };
    if (isGraceOwnSource(p)) return { error: `Refused: ${p} is part of Grace's own source code — change your own tools/code via create_tool (sandbox-validated), not raw write_file.` };
    const content = String(args.content ?? '');
    undoManager.beforeWrite(p, `write ${path.basename(p)}`);
    try {
      await fs.mkdir(path.dirname(p), { recursive: true });
      
      let finalMode = args.mode || (args.append ? 'append' : 'overwrite');
      
      if (finalMode === 'append') {
        await fs.appendFile(p, content, 'utf-8');
      } else if (finalMode === 'prepend') {
        let existing = '';
        try { existing = await fs.readFile(p, 'utf-8'); } catch (e) { /* ignore */ }
        await fs.writeFile(p, content + existing, 'utf-8');
      } else {
        await fs.writeFile(p, content, 'utf-8');
      }
      
      return { path: p, bytes: Buffer.byteLength(content, 'utf-8'), mode: finalMode, ok: true };
    } catch (e) { return { path: p, error: String(e) }; }
  },
});
