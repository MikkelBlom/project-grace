import { registerTool } from '../registry.js';

// Read a local file's text contents. Returns the WHOLE file by default (Grace's
// context window is large now). Only very large files get truncated — and when
// that happens the result says so LOUDLY, so Grace never overwrites a file from
// a partial view (that was destroying files: read 40 of 52 lines → write_file
// overwrite → the last 12 lines gone).
registerTool({
  name: 'read_file',
  description: 'Read the text contents of a local file. Returns the whole file by default. Very large files come back as a chunk with "truncated": true — read more with {offset, lines}. NEVER write_file(overwrite) a file you only read partially: overwrite replaces the ENTIRE file and deletes anything you did not include. To change part of a file, prefer edit_file.',
  params: {
    path: { type: 'string', description: 'absolute path to the file', required: true },
    lines: { type: 'number', description: 'max lines to return (optional; defaults to the whole file, with a safety cap for very large files)' },
    offset: { type: 'number', description: '1-based line number to start reading from (optional; pair with "lines" to page through a large file)' },
    show_line_numbers: { type: 'boolean', description: 'prefix each line with its absolute line number (e.g. "[1] ") to help with targeted edits' },
  },
  async run(args) {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const raw = String(args.path ?? '');
    if (!raw) throw new Error('path is required');
    const home = path.resolve(os.homedir());
    const p = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(home, raw);

    const DEFAULT_MAX_LINES = 2000;   // whole file for anything normal-sized
    const HARD_MAX_LINES = 20000;     // ceiling even when more is explicitly requested
    const CHAR_CAP = 200_000;         // ~50k tokens — safe inside the 128K window

    const nLines = Number(args.lines);
    const maxLines = args.lines != null && Number.isFinite(nLines)
      ? Math.max(1, Math.min(HARD_MAX_LINES, Math.floor(nLines)))
      : DEFAULT_MAX_LINES;
    const nOff = Number(args.offset);
    const start = args.offset != null && Number.isFinite(nOff) ? Math.max(0, Math.floor(nOff) - 1) : 0;

    let data: string;
    try { data = await fs.readFile(p, 'utf-8'); }
    catch (e) { return { path: p, error: String(e) }; }

    const all = data.split(/\r?\n/);
    let slice = all.slice(start, start + maxLines);

    // Character budget so a handful of enormous lines can't blow the context window.
    let charCapped = false;
    if (slice.join('\n').length > CHAR_CAP) {
      charCapped = true;
      while (slice.length > 1 && slice.join('\n').length > CHAR_CAP) slice.pop();
    }

    const end = start + slice.length;            // exclusive, 0-based
    const truncated = start > 0 || end < all.length || charCapped;
    const text = args.show_line_numbers
      ? slice.map((l, i) => `[${start + i + 1}] ${l}`).join('\n')
      : slice.join('\n');

    const out: Record<string, unknown> = {
      path: p,
      totalLines: all.length,
      offset: start + 1,                          // 1-based first line returned
      returned: slice.length,
      truncated,
      text,
    };
    if (truncated) {
      out.warning =
        `PARTIAL VIEW: returned lines ${start + 1}-${end} of ${all.length}. ` +
        `Do NOT write_file(overwrite) this file from this text — it would delete the ${all.length - slice.length} line(s) you did not see. ` +
        `Read the rest with {offset: ${end + 1}, lines: ...}, or change it with edit_file (surgical replace).`;
    }
    return out;
  },
});
