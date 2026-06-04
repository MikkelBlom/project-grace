import { registerTool } from '../registry.js';

// Versatile tool to edit files surgically.
registerTool({
  name: 'edit_file',
  description: 'Make surgical edits to an existing text file. You can replace specific strings, insert text before/after a string, or modify specific line numbers. Use this instead of write_file when you only want to change a small part of a document.',
  params: {
    path: { type: 'string', description: 'absolute path of the file to edit', required: true },
    mode: { type: 'string', description: 'one of: "replace_string", "insert_before_string", "insert_after_string", "insert_at_line", "replace_line", "delete_line"', required: true },
    target_string: { type: 'string', description: 'the exact string to target (required for string modes)' },
    line_number: { type: 'number', description: 'the 1-indexed line number to target (required for line modes)' },
    content: { type: 'string', description: 'the new content to insert or replace with (required for all modes except delete_line)' },
    replace_all: { type: 'boolean', description: 'for "replace_string" mode, whether to replace all occurrences (default true)' },
  },
  async run(args) {
    const fs = await import('fs/promises');
    const path = await import('path');
    const os = await import('os');
    
    const raw = String(args.path ?? '');
    if (!raw) throw new Error('path is required');
    const home = path.resolve(os.homedir());
    const p = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(home, raw);
    
    if (!p.startsWith(home)) return { error: `Refused: ${p} is outside your home folder (${home}). Only files under home can be edited.` };
    
    let text: string;
    try { text = await fs.readFile(p, 'utf-8'); } catch (e) { return { error: String(e) }; }
    
    const mode = String(args.mode);
    const content = args.content !== undefined ? String(args.content) : '';
    const target = args.target_string !== undefined ? String(args.target_string) : '';
    const lineNum = Number(args.line_number);

    let newText = text;
    let lines = text.split(/\r?\n/);
    
    if (['replace_string', 'insert_before_string', 'insert_after_string'].includes(mode)) {
      if (!target) return { error: 'target_string is required for string modes.' };
      if (!text.includes(target)) return { error: `target_string not found in file: ${target.substring(0,50)}...` };
      
      if (mode === 'replace_string') {
        if (args.replace_all !== false) {
          const parts = text.split(target);
          newText = parts.join(content);
        } else {
          newText = text.replace(target, content);
        }
      } else if (mode === 'insert_before_string') {
        newText = text.replace(target, content + target);
      } else if (mode === 'insert_after_string') {
        newText = text.replace(target, target + content);
      }
    } 
    else if (['insert_at_line', 'replace_line', 'delete_line'].includes(mode)) {
      if (!Number.isFinite(lineNum) || lineNum < 1) return { error: 'line_number must be >= 1.' };
      const idx = lineNum - 1;
      
      if (mode === 'insert_at_line') {
        if (idx > lines.length) return { error: `line_number ${lineNum} is out of bounds (file has ${lines.length} lines).` };
        lines.splice(idx, 0, content);
      } else if (mode === 'replace_line') {
        if (idx >= lines.length) return { error: `line_number ${lineNum} is out of bounds.` };
        lines[idx] = content;
      } else if (mode === 'delete_line') {
        if (idx >= lines.length) return { error: `line_number ${lineNum} is out of bounds.` };
        lines.splice(idx, 1);
      }
      newText = lines.join('\n');
    } else {
      return { error: `Unknown mode: ${mode}` };
    }
    
    await fs.writeFile(p, newText, 'utf-8');
    return { path: p, mode, ok: true };
  }
});
