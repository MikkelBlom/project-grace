import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerTool } from '../registry.js';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const TODO_PATH = path.join(ROOT, 'data', 'todos.json');

interface Todo { id: number; text: string; done: boolean; created: string; }

function load(): Todo[] {
  try { const d = JSON.parse(fs.readFileSync(TODO_PATH, 'utf8')); return Array.isArray(d.todos) ? d.todos : []; } catch { return []; }
}
function save(todos: Todo[]): void {
  try { fs.mkdirSync(path.dirname(TODO_PATH), { recursive: true }); fs.writeFileSync(TODO_PATH, JSON.stringify({ todos }, null, 2), 'utf8'); } catch { /* best-effort */ }
}

registerTool({
  name: 'add_todo',
  description: 'Add a to-do item for Mikkel (a task to do, not a timed reminder). Use when he says "add to my to-do list", "remind me to..." (a task).',
  params: { text: { type: 'string', description: 'the task', required: true } },
  async run(args) {
    const text = String(args.text ?? '').trim();
    if (!text) return { error: 'text is required' };
    const todos = load();
    const id = todos.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    todos.push({ id, text, done: false, created: new Date().toISOString() });
    save(todos);
    return { ok: true, id, text, openCount: todos.filter((t) => !t.done).length };
  },
});

registerTool({
  name: 'list_todos',
  description: "List Mikkel's to-do items (open ones by default).",
  params: { all: { type: 'boolean', description: 'include completed items (default false)' } },
  async run(args) {
    const todos = load();
    const show = args.all ? todos : todos.filter((t) => !t.done);
    return { count: show.length, todos: show.map((t) => ({ id: t.id, text: t.text, done: t.done })) };
  },
});

registerTool({
  name: 'complete_todo',
  description: 'Mark a to-do item done by its id (from list_todos).',
  params: { id: { type: 'number', description: 'the todo id', required: true } },
  async run(args) {
    const todos = load();
    const t = todos.find((x) => x.id === Number(args.id));
    if (!t) return { error: `no todo with id ${args.id}` };
    t.done = true;
    save(todos);
    return { ok: true, completed: t.text, openCount: todos.filter((x) => !x.done).length };
  },
});
