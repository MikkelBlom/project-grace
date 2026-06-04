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
    'You MUST ALWAYS output your response as a SINGLE JSON object in the exact following format:',
    '{',
    '  "speak": "Text you want to say to Mikkel (leave empty to work silently)",',
    '  "tool": "name of the tool to call, or null if no tool is needed",',
    '  "args": { "param": "value" },',
    '  "done": false',
    '}',
    'Set "done" to true ONLY when you have fully completed the background task. For anything needing live or local data, you MUST set "tool" and "args". NEVER guess or refuse. You can set both "speak" and "tool" in the same response to explain what you are doing while doing it.',
  );
  return lines.join('\n');
}

export interface ToolInvocation { tool: string; args: Record<string, any>; speak: string; done: boolean; }

export function parseToolCall(text: string): ToolInvocation | null {
  const parse = (s: string): ToolInvocation | null => {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object') {
        return {
          tool: typeof obj.tool === 'string' ? obj.tool : '',
          args: typeof obj.args === 'object' && obj.args !== null ? obj.args : {},
          speak: typeof obj.speak === 'string' ? obj.speak : '',
          done: !!obj.done
        };
      }
    } catch {}
    return null;
  };

  let s = text.trim();
  let res = parse(s);
  if (res) return res;

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    res = parse(fence[1].trim());
    if (res) return res;
  }

  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    res = parse(s.slice(start, end + 1));
    if (res) return res;
  }

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
