import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerTool } from '../registry.js';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const HABITS_PATH = path.join(ROOT, 'data', 'habits.json');

interface Habit { id: number; name: string; done: string[]; }

function load(): Habit[] {
  try { const d = JSON.parse(fs.readFileSync(HABITS_PATH, 'utf8')); return Array.isArray(d.habits) ? d.habits : []; } catch { return []; }
}
function save(habits: Habit[]): void {
  try { fs.mkdirSync(path.dirname(HABITS_PATH), { recursive: true }); fs.writeFileSync(HABITS_PATH, JSON.stringify({ habits }, null, 2), 'utf8'); } catch { /* best-effort */ }
}

// Local calendar date (YYYY-MM-DD) — habit dedup/streaks should follow Mikkel's day, not UTC.
function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
// Integer day-number for a YYYY-MM-DD string, so consecutive days differ by exactly 1.
function dayNum(s: string): number { return Math.floor(Date.parse(`${s}T00:00:00Z`) / 86_400_000); }

// Compute current + longest streak from a list of done-dates.
// current: the run of consecutive days ending today (or yesterday, so the streak is still "alive"
// before he logs today). longest: the longest consecutive run ever.
function streaks(dates: string[]): { current: number; longest: number; doneToday: boolean; total: number } {
  const uniq = [...new Set(dates.filter(Boolean))].sort();
  if (!uniq.length) return { current: 0, longest: 0, doneToday: false, total: 0 };
  const nums = uniq.map(dayNum);
  const set = new Set(nums);
  let longest = 1, run = 1;
  for (let i = 1; i < nums.length; i++) {
    run = nums[i] === nums[i - 1]! + 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  const todayNum = dayNum(localDate());
  const doneToday = set.has(todayNum);
  const anchor = set.has(todayNum) ? todayNum : (set.has(todayNum - 1) ? todayNum - 1 : null);
  let current = 0;
  if (anchor !== null) { let d = anchor; while (set.has(d)) { current++; d--; } }
  return { current, longest, doneToday, total: uniq.length };
}

// Resolve a habit by numeric id or (case-insensitive) name.
function findHabit(habits: Habit[], args: Record<string, any>): Habit | undefined {
  if (args.id !== undefined && args.id !== null && String(args.id).trim() !== '') {
    const h = habits.find((x) => x.id === Number(args.id));
    if (h) return h;
  }
  const name = String(args.name ?? '').trim().toLowerCase();
  if (name) return habits.find((x) => x.name.toLowerCase() === name);
  return undefined;
}

registerTool({
  name: 'add_habit',
  description: 'Add a habit for Mikkel to track (e.g. "exercise", "read", "meditate"). Use when he says "I want to start a habit of...", "track that I...", or "add a daily habit".',
  params: { name: { type: 'string', description: 'the habit name', required: true } },
  async run(args) {
    const name = String(args.name ?? '').trim();
    if (!name) return { error: 'name is required' };
    const habits = load();
    const existing = habits.find((h) => h.name.toLowerCase() === name.toLowerCase());
    if (existing) return { ok: true, id: existing.id, name: existing.name, note: 'habit already exists' };
    const id = habits.reduce((m, h) => Math.max(m, h.id), 0) + 1;
    habits.push({ id, name, done: [] });
    save(habits);
    return { ok: true, id, name, habitCount: habits.length };
  },
});

registerTool({
  name: 'list_habits',
  description: "List Mikkel's tracked habits with whether each is done today and its current streak.",
  async run() {
    const habits = load();
    return {
      count: habits.length,
      habits: habits.map((h) => {
        const s = streaks(h.done);
        return { id: h.id, name: h.name, doneToday: s.doneToday, currentStreak: s.current, longestStreak: s.longest, timesLogged: s.total };
      }),
    };
  },
  params: {},
});

registerTool({
  name: 'log_habit',
  description: 'Mark a habit done for today (deduplicated — logging twice in one day counts once). Identify the habit by name or id. Use when Mikkel says he did a habit today.',
  params: {
    name: { type: 'string', description: 'the habit name (or use id)' },
    id: { type: 'number', description: 'the habit id (from list_habits), alternative to name' },
  },
  async run(args) {
    const habits = load();
    const h = findHabit(habits, args);
    if (!h) return { error: `no habit matching ${args.id ?? args.name ?? '(none given)'} — add it first with add_habit` };
    const day = localDate();
    const already = h.done.includes(day);
    if (!already) { h.done.push(day); save(habits); }
    const s = streaks(h.done);
    return { ok: true, habit: h.name, date: day, alreadyLogged: already, currentStreak: s.current, longestStreak: s.longest };
  },
});

registerTool({
  name: 'habit_streak',
  description: 'Get the current and longest streak for a habit (identify by name or id). Use when Mikkel asks "what\'s my streak" or how a habit is going.',
  params: {
    name: { type: 'string', description: 'the habit name (or use id)' },
    id: { type: 'number', description: 'the habit id (from list_habits), alternative to name' },
  },
  async run(args) {
    const habits = load();
    const h = findHabit(habits, args);
    if (!h) return { error: `no habit matching ${args.id ?? args.name ?? '(none given)'}` };
    const s = streaks(h.done);
    return { ok: true, habit: h.name, currentStreak: s.current, longestStreak: s.longest, doneToday: s.doneToday, timesLogged: s.total };
  },
});
