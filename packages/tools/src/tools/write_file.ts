import { registerTool } from '../registry.js';

// Create / write a text file (gated to the user's home folder for safety).
registerTool({
  name: 'write_file',
  description: 'Create or write a TEXT file on disk (notes, ideas, code, etc). Only allowed under the user home folder. Set append:true to add to an existing file instead of overwriting it.',
  params: {
    path: { type: 'string', description: 'absolute path of the file to write (must be under the home folder)', required: true },
    content: { type: 'string', description: 'the text content to write', required: true },
    append: { type: 'boolean', description: 'append instead of overwrite (optional, default false)' },
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
      if (args.append) await fs.appendFile(p, content, 'utf-8');
      else await fs.writeFile(p, content, 'utf-8');
      return { path: p, bytes: Buffer.byteLength(content, 'utf-8'), mode: args.append ? 'append' : 'overwrite', ok: true };
    } catch (e) { return { path: p, error: String(e) }; }
  },
});
