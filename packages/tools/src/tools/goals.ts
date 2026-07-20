import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerTool } from '../registry.js';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const GOALS_PATH = path.join(ROOT, 'data', 'goals.json');

type GoalStatus = 'active' | 'done' | 'dropped';
interface Goal { id: number; text: string; status: GoalStatus; created: string; updated: string; }

const STATUSES: GoalStatus[] = ['active', 'done', 'dropped'];

function load(): Goal[] {
  try { const d = JSON.parse(fs.readFileSync(GOALS_PATH, 'utf8')); return Array.isArray(d.goals) ? d.goals : []; } catch { return []; }
}
function save(goals: Goal[]): void {
  try { fs.mkdirSync(path.dirname(GOALS_PATH), { recursive: true }); fs.writeFileSync(GOALS_PATH, JSON.stringify({ goals }, null, 2), 'utf8'); } catch { /* best-effort */ }
}

registerTool({
  name: 'add_goal',
  description: "Add a goal for Mikkel to track across sessions (a longer-term aim, not a quick to-do). Use when he says \"my goal is...\", \"I want to achieve...\", or \"add a goal\".",
  params: { text: { type: 'string', description: 'the goal', required: true } },
  async run(args) {
    const text = String(args.text ?? '').trim();
    if (!text) return { error: 'text is required' };
    const goals = load();
    const id = goals.reduce((m, g) => Math.max(m, g.id), 0) + 1;
    const now = new Date().toISOString();
    goals.push({ id, text, status: 'active', created: now, updated: now });
    save(goals);
    return { ok: true, id, text, openCount: goals.filter((g) => g.status === 'active').length };
  },
});

registerTool({
  name: 'list_goals',
  description: "List Mikkel's goals (open/active ones by default). Use to review what he's working toward.",
  params: {
    status: { type: 'string', description: 'filter by status: active | done | dropped (default active)' },
    all: { type: 'boolean', description: 'include goals of every status (default false)' },
  },
  async run(args) {
    const goals = load();
    const status = String(args.status ?? '').trim().toLowerCase();
    let show = goals;
    if (!args.all) {
      const want = STATUSES.includes(status as GoalStatus) ? status : 'active';
      show = goals.filter((g) => g.status === want);
    } else if (STATUSES.includes(status as GoalStatus)) {
      show = goals.filter((g) => g.status === status);
    }
    return { count: show.length, goals: show.map((g) => ({ id: g.id, text: g.text, status: g.status, updated: g.updated.slice(0, 10) })) };
  },
});

registerTool({
  name: 'update_goal',
  description: "Update a goal by its id (from list_goals): change its status (active, done, dropped) and/or edit its text. Use when Mikkel completes, drops, or rewords a goal.",
  params: {
    id: { type: 'number', description: 'the goal id', required: true },
    status: { type: 'string', description: 'new status: active | done | dropped' },
    text: { type: 'string', description: 'new text for the goal' },
  },
  async run(args) {
    const goals = load();
    const g = goals.find((x) => x.id === Number(args.id));
    if (!g) return { error: `no goal with id ${args.id}` };
    const status = String(args.status ?? '').trim().toLowerCase();
    const text = String(args.text ?? '').trim();
    if (!status && !text) return { error: 'provide a new status and/or text to update' };
    if (status) {
      if (!STATUSES.includes(status as GoalStatus)) return { error: `status must be one of: ${STATUSES.join(', ')}` };
      g.status = status as GoalStatus;
    }
    if (text) g.text = text;
    g.updated = new Date().toISOString();
    save(goals);
    return { ok: true, id: g.id, text: g.text, status: g.status, openCount: goals.filter((x) => x.status === 'active').length };
  },
});
