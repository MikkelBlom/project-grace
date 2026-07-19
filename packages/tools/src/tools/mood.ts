import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerTool } from '../registry.js';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MOOD_PATH = path.join(ROOT, 'data', 'mood.json');

interface MoodEntry { mood: string; note: string; ts: string; }
function load(): MoodEntry[] { try { const d = JSON.parse(fs.readFileSync(MOOD_PATH, 'utf8')); return Array.isArray(d.entries) ? d.entries : []; } catch { return []; } }
function save(entries: MoodEntry[]): void { try { fs.mkdirSync(path.dirname(MOOD_PATH), { recursive: true }); fs.writeFileSync(MOOD_PATH, JSON.stringify({ entries }, null, 2), 'utf8'); } catch { /* best-effort */ } }

registerTool({
  name: 'log_mood',
  description: "Log Mikkel's current energy or mood (self-reported), timestamped. Use when he mentions how he's feeling or his energy level, or asks you to track it over time.",
  params: {
    mood: { type: 'string', description: 'e.g. "energized", "tired", "focused", "stressed", "good"', required: true },
    note: { type: 'string', description: 'optional context (what he is doing / why)' },
  },
  async run(args) {
    const mood = String(args.mood ?? '').trim();
    if (!mood) return { error: 'mood is required' };
    const entries = load();
    entries.push({ mood, note: String(args.note ?? '').trim(), ts: new Date().toISOString() });
    save(entries);
    return { ok: true, logged: mood, totalEntries: entries.length };
  },
});

registerTool({
  name: 'mood_summary',
  description: "Summarize Mikkel's recently logged moods/energy so he (or Grace) can see the trend.",
  params: { limit: { type: 'number', description: 'how many recent entries (default 20)' } },
  async run(args) {
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 20));
    const entries = load().slice(-limit).reverse();
    return { count: entries.length, entries: entries.map((e) => ({ mood: e.mood, note: e.note, when: e.ts.slice(0, 16).replace('T', ' ') })) };
  },
});
