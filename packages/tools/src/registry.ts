// ─────────────────────────────────────────────
// Grace — tool framework (registry, helpers, task state)
//
// Self-contained registry so Grace can call tools. Tools self-register by
// importing registerTool and calling it at module load time.
//
// Protocol: Grace replies with ONE line of JSON {"tool":"name","args":{...}}.
// OllamaLLM detects it, runs the tool, then asks the model to answer with the result.
// ─────────────────────────────────────────────

import path from 'path';
import { fileURLToPath } from 'url';

/** Passed to every tool's run() so a tool can call OTHER tools (e.g. news_fetcher → web_search). */
export interface ToolContext { callTool: (name: string, args?: Record<string, any>) => Promise<unknown>; }

export interface ToolSpec {
  name: string;
  description: string;
  params: Record<string, { type: string; description: string; required?: boolean }>;
  run(args: Record<string, any>, ctx?: ToolContext): Promise<unknown>;
}

const tools = new Map<string, ToolSpec>();

// Grace's own source tree ("her brain"). Mutating tools refuse to edit these — changes to her own
// code/tools must go through create_tool (sandbox-validated), not raw edit_file/write_file.
const REPO_ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export function isGraceOwnSource(p: string): boolean {
  const rel = path.relative(REPO_ROOT, path.resolve(p));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return ['packages', 'sandbox', 'scripts', 'shared'].includes(rel.split(path.sep)[0]);
}

export function registerTool(t: ToolSpec): void { tools.set(t.name, t); }
export function listTools(): ToolSpec[] { return [...tools.values()]; }

/** Catalog text injected into the system prompt so the model knows what it can call. */
export function describeTools(): string {
  if (tools.size === 0) return '';
  const lines = ['TOOLS you can call:'];
  for (const t of tools.values()) {
    const ps = Object.entries(t.params)
      .map(([k, v]) => `${k} (${v.type}${v.required ? ', required' : ''}): ${v.description}`)
      .join('; ');
    lines.push(`- ${t.name}: ${t.description}${ps ? ` | args: ${ps}` : ' | args: none'}`);
  }
  lines.push(
    '',
    'You MUST ALWAYS reply with ONE JSON object in this exact shape:',
    '{',
    '  "thought": "Think step-by-step: what does Mikkel need, and which tool(s)? (required)",',
    '  "tool": "ONE tool name to call, or null if no tool is needed",',
    '  "args": { "param": "value" },',
    '  "speak": "What to say to Mikkel out loud (leave empty to work silently)",',
    '  "done": false',
    '}',
    'To call SEVERAL INDEPENDENT tools in one turn (e.g. location AND weather), use "tools" instead of "tool":',
    '  { "thought": "...", "tools": [ {"tool":"get_location","args":{}}, {"tool":"get_weather","args":{"city":"Copenhagen"}} ], "speak":"", "done":false }',
    'Batch ONLY tools that do not depend on each other. When one tool\'s result feeds the next, do them one turn at a time.',
    'For anything needing live or local data you MUST call a tool — NEVER guess or refuse. Set "done" true ONLY when a background task is fully finished AND verified. You may set both "speak" and a tool in the same reply to talk while you act.',
  );
  return lines.join('\n');
}

export interface ToolCall { tool: string; args: Record<string, any>; }
export interface ToolInvocation { thought: string; speak: string; done: boolean; calls: ToolCall[]; }

// Parse the model's JSON reply. Accepts both the single-call form ("tool" + "args")
// and the multi-call form ("tools": [{tool,args}, ...]) and normalizes to a calls[] list.
export function parseToolCall(text: string): ToolInvocation | null {
  const tryParse = (s: string): any => { try { return JSON.parse(s); } catch { return null; } };

  const s = (text ?? '').trim();
  let obj = tryParse(s);
  if (!obj) {
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) obj = tryParse(fence[1].trim());
  }
  if (!obj) {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) obj = tryParse(s.slice(start, end + 1));
  }
  if (!obj || typeof obj !== 'object') return null;

  const isCallable = (name: unknown): name is string =>
    typeof name === 'string' && name.trim() !== '' && name !== 'null' && name !== 'reply';
  const asArgs = (a: unknown): Record<string, any> =>
    a && typeof a === 'object' && !Array.isArray(a) ? a as Record<string, any> : {};

  const calls: ToolCall[] = [];
  if (Array.isArray(obj.tools)) {
    for (const c of obj.tools) {
      if (c && typeof c === 'object' && isCallable(c.tool)) calls.push({ tool: c.tool, args: asArgs(c.args) });
    }
  }
  if (isCallable(obj.tool)) calls.push({ tool: obj.tool, args: asArgs(obj.args) });

  return {
    thought: typeof obj.thought === 'string' ? obj.thought : '',
    speak: typeof obj.speak === 'string' ? obj.speak : '',
    done: !!obj.done,
    calls,
  };
}

export async function runTool(name: string, args: Record<string, any>): Promise<unknown> {
  const t = tools.get(name);
  if (!t) return { error: `Unknown tool: ${name}` };
  try { return await t.run(args ?? {}, { callTool: (n, a) => runTool(n, a ?? {}) }); }
  catch (e) { return { error: String(e) }; }
}

// ── helpers ──────────────────────────────────────────────────────
export async function fetchJson(url: string, timeoutMs = 8000): Promise<any> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'GraceAssistant/0.1' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Background-task registry (for autonomous "I'll get back to you" work) ──
export interface TaskState {
  id: string; description: string; phase: string; log: string[];
  result?: string; done: boolean; failed?: boolean; startedAt: number;
}
class TaskRegistryImpl {
  current: TaskState | null = null;
  cancelRequested = false;
  paused = false;
  start(description: string): TaskState {
    this.cancelRequested = false;
    this.paused = false;
    this.current = { id: 'task-' + Date.now(), description, phase: 'planning', log: [], done: false, startedAt: Date.now() };
    return this.current;
  }
  /** Ask the running task to stop at its next step. Returns false if nothing is running. */
  requestCancel(): boolean { if (this.current && !this.current.done) { this.cancelRequested = true; this.paused = false; return true; } return false; }
  /** Ask the running task to hold at its next step. Returns false if nothing is running. */
  requestPause(): boolean { if (this.current && !this.current.done) { this.paused = true; return true; } return false; }
  /** Release a paused task. */
  resume(): void { this.paused = false; }
  update(phase: string): void { if (this.current && !this.current.done) this.current.phase = phase; }
  log(line: string): void { if (this.current) { this.current.log.push(line); if (this.current.log.length > 25) this.current.log.shift(); } }
  finish(result: string): void { if (this.current) { this.current.result = result; this.current.done = true; this.current.phase = 'done'; } }
  fail(err: string): void { if (this.current) { this.current.failed = true; this.current.done = true; this.current.phase = 'failed'; this.current.result = err; } }
  isRunning(): boolean { return !!this.current && !this.current.done; }
  status(): string {
    const t = this.current;
    if (!t) return 'No task is running and none has run yet.';
    const secs = Math.round((Date.now() - t.startedAt) / 1000);
    if (t.done) return t.failed ? `The last task failed: ${t.result}` : `That task is finished. Result: ${t.result}`;
    return `Still working on "${t.description}" — currently ${t.phase}, about ${secs} seconds in. Recently: ${t.log.slice(-2).join('; ') || 'getting started'}.`;
  }
}
export const TaskRegistry = new TaskRegistryImpl();

// ── Mission registry (long-running autonomous "work through a backlog for hours") ──
// A mission is an objective + a backlog of items (e.g. tools to build). The driver works
// one item at a time, surviving per-item step caps; this holds the cross-item state and
// the pause/cancel flags so a hotkey can halt the whole run between items.
export interface MissionState {
  id: string;
  objective: string;
  backlog: string[];
  completed: string[];
  failed: string[];
  /** Risky tools that passed the sandbox but need Mikkel's approval — not promoted, awaiting review. */
  pending: string[];
  current?: string;
  phase: string;
  startedAt: number;
  done: boolean;
}
class MissionRegistryImpl {
  current: MissionState | null = null;
  cancelRequested = false;
  paused = false;
  start(objective: string, backlog: string[] = []): MissionState {
    this.cancelRequested = false;
    this.paused = false;
    this.current = {
      id: 'mission-' + Date.now(), objective, backlog: [...backlog], completed: [], failed: [], pending: [],
      phase: 'planning', startedAt: Date.now(), done: false,
    };
    return this.current;
  }
  setBacklog(items: string[]): void { if (this.current) this.current.backlog = [...items]; }
  addToBacklog(items: string[]): void { if (this.current) this.current.backlog.push(...items); }
  /** Pull the next backlog item into "current" and return it, or undefined if the backlog is empty. */
  nextItem(): string | undefined {
    if (!this.current) return undefined;
    const item = this.current.backlog.shift();
    this.current.current = item;
    return item;
  }
  completeCurrent(note?: string): void { if (this.current?.current) { this.current.completed.push(note || this.current.current); this.current.current = undefined; } }
  failCurrent(note?: string): void { if (this.current?.current) { this.current.failed.push(note || this.current.current); this.current.current = undefined; } }
  pendingCurrent(note?: string): void { if (this.current?.current) { this.current.pending.push(note || this.current.current); this.current.current = undefined; } }
  phase(p: string): void { if (this.current && !this.current.done) this.current.phase = p; }
  finish(): void { if (this.current) { this.current.done = true; this.current.phase = 'done'; this.current.current = undefined; } }
  requestCancel(): boolean { if (this.current && !this.current.done) { this.cancelRequested = true; this.paused = false; return true; } return false; }
  requestPause(): boolean { if (this.current && !this.current.done) { this.paused = true; return true; } return false; }
  resume(): void { this.paused = false; }
  isRunning(): boolean { return !!this.current && !this.current.done; }
  status(): string {
    const m = this.current;
    if (!m) return 'No mission is running.';
    const mins = Math.round((Date.now() - m.startedAt) / 60000);
    const head = `Mission "${m.objective.slice(0, 80)}" — ${m.done ? 'finished' : (this.paused ? 'paused' : m.phase)}, ~${mins} min in.`;
    return `${head} Done ${m.completed.length}${m.failed.length ? `, failed ${m.failed.length}` : ''}${m.pending.length ? `, ${m.pending.length} awaiting your approval` : ''}, ${m.backlog.length} left in the backlog.${m.current ? ` Currently: ${m.current}.` : ''}`;
  }
}
export const MissionRegistry = new MissionRegistryImpl();
