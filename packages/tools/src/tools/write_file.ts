import { registerTool } from '../registry.js';

// Create / write a text file (gated to the user's home folder for safety).
registerTool({
  name: 'write_file',
  description: 'Create or write a TEXT file on disk (notes, ideas, code). DANGER: By default this OVERWRITES the entire file, deleting existing content! Use mode="append" to add to the bottom, or mode="prepend" to add to the top.',
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
    if (!p.startsWith(home)) return { error: `Refused: ${p} is outside your home folder (${home}). Only files under home can be written.` };
    const content = String(args.content ?? '');
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
