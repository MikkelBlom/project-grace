import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerTool } from '../registry.js';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const NOTES_PATH = path.join(ROOT, 'data', 'notes.md');

registerTool({
  name: 'save_note',
  description: 'Save a quick note for Mikkel (timestamped, appended to his notes file). Use when he says "note that...", "jot down...", "make a note...".',
  params: { text: { type: 'string', description: 'the note text', required: true } },
  async run(args) {
    const text = String(args.text ?? '').trim();
    if (!text) return { error: 'text is required' };
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
    try {
      fs.mkdirSync(path.dirname(NOTES_PATH), { recursive: true });
      fs.appendFileSync(NOTES_PATH, `- [${stamp}] ${text}\n`, 'utf8');
    } catch (e) { return { error: String(e) }; }
    return { ok: true, saved: text };
  },
});

registerTool({
  name: 'list_notes',
  description: "List Mikkel's recent saved notes.",
  params: { limit: { type: 'number', description: 'how many recent notes (default 15)' } },
  async run(args) {
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 15));
    let lines: string[] = [];
    try { lines = fs.readFileSync(NOTES_PATH, 'utf8').split('\n').filter((l) => l.trim()); } catch { return { count: 0, notes: [] }; }
    return { count: Math.min(lines.length, limit), notes: lines.slice(-limit).reverse() };
  },
});
