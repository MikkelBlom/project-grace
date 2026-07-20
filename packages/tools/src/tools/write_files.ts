import { undoManager } from '@grace/core';
import { registerTool, isGraceOwnSource } from '../registry.js';

// Bulk-write multiple files in a single tool call.
// Replaces the pattern of 50 separate write_file calls that corrupt at high batch counts.
registerTool({
  name: 'write_files',
  description:
    'Write multiple files at once. PREFERRED over calling write_file many times — ' +
    'faster, and avoids JSON corruption on large batches. Each entry creates or overwrites a file. ' +
    'Max 25 files per call; for more, call again with the next batch.',
  params: {
    files: {
      type: 'array',
      description:
        'Array of objects: [{ "path": "absolute or relative-to-home path", "content": "text to write", "mode": "overwrite|append|prepend" }, ...]. Max 25.',
      required: true,
    },
  },
  async run(args) {
    const os = await import('os');
    const fs = await import('fs/promises');
    const pathMod = await import('path');
    const home = pathMod.resolve(os.homedir());

    const files = Array.isArray(args.files) ? args.files : [];
    if (files.length === 0) return { error: 'files array is empty — nothing to write.' };
    if (files.length > 25) return { error: `Too many files (${files.length}). Max 25 per call — split into batches.` };

    const results: Array<{ path: string; bytes: number; ok: boolean }> = [];
    const failed: Array<{ path: string; error: string }> = [];

    for (const entry of files) {
      const raw = String(entry?.path ?? '');
      if (!raw) { failed.push({ path: '(empty)', error: 'path is required' }); continue; }

      const p = pathMod.isAbsolute(raw) ? pathMod.resolve(raw) : pathMod.resolve(home, raw);
      if (!(p === home || p.startsWith(home + pathMod.sep))) {
        failed.push({ path: p, error: `Outside home folder (${home}).` });
        continue;
      }
      if (isGraceOwnSource(p)) {
        failed.push({ path: p, error: 'Part of Grace\'s own source — use create_tool instead.' });
        continue;
      }

      const content = String(entry?.content ?? '');
      const mode = String(entry?.mode || 'overwrite');

      try {
        await fs.mkdir(pathMod.dirname(p), { recursive: true });
        undoManager.beforeWrite(p, `write ${pathMod.basename(p)}`);

        if (mode === 'append') {
          await fs.appendFile(p, content, 'utf-8');
        } else if (mode === 'prepend') {
          let existing = '';
          try { existing = await fs.readFile(p, 'utf-8'); } catch { /* new file */ }
          await fs.writeFile(p, content + existing, 'utf-8');
        } else {
          await fs.writeFile(p, content, 'utf-8');
        }

        results.push({ path: p, bytes: Buffer.byteLength(content, 'utf-8'), ok: true });
      } catch (e) {
        failed.push({ path: p, error: String(e) });
      }
    }

    return { created: results.length, failed: failed.length, results, errors: failed.length ? failed : undefined };
  },
});
