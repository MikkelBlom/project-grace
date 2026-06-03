// ─────────────────────────────────────────────
// Grace — tool framework (registry, helpers, task state)
//
// Self-contained registry so Grace can call tools. Tools self-register by
// importing registerTool and calling it at module load time.
//
// Protocol: Grace replies with ONE line of JSON {"tool":"name","args":{...}}.
// OllamaLLM detects it, runs the tool, then asks the model to answer with the result.
// ─────────────────────────────────────────────

export interface ToolSpec {
  name: string;
  description: string;
  params: Record<string, { type: string; description: string; required?: boolean }>;
  run(args: Record<string, any>): Promise<unknown>;
}

const tools = new Map<string, ToolSpec>();

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
    'To use a tool, output ONLY this single line of JSON, with NOTHING before or after it:',
    '{"tool":"name","args":{...}}',
    'For anything needing live or local data — weather, your location, files on this PC — you MUST call the matching tool; never guess or refuse. After you receive the result, answer Mikkel briefly in English. For things you already know, just answer normally.',
  );
  return lines.join('\n');
}

export interface ToolInvocation { tool: string; args: Record<string, any>; }

/** Detect a tool-call JSON in the model's reply. Returns null for normal prose. */
export function parseToolCall(text: string): ToolInvocation | null {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  // Extract the first balanced {...} object, tolerating prose before/after it
  // (the model sometimes appends "I'll search..." after the JSON).
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    if (obj && typeof obj.tool === 'string') {
      return { tool: obj.tool, args: (obj.args && typeof obj.args === 'object') ? obj.args : {} };
    }
  } catch { /* not a tool call — normal reply */ }
  return null;
}

export async function runTool(name: string, args: Record<string, any>): Promise<unknown> {
  const t = tools.get(name);
  if (!t) return { error: `Unknown tool: ${name}` };
  try { return await t.run(args ?? {}); }
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
  start(description: string): TaskState {
    this.current = { id: 'task-' + Date.now(), description, phase: 'planning', log: [], done: false, startedAt: Date.now() };
    return this.current;
  }
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
