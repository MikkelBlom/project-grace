// ─────────────────────────────────────────────────────────────────────────────
// Minimal MCP (Model Context Protocol) client — zero external deps.
//
// Speaks JSON-RPC 2.0 to an external MCP server over either transport:
//   • stdio — we spawn `{command, args}` and talk over its stdin/stdout. Framing is
//     newline-delimited JSON (what most servers accept), and we ALSO parse the
//     `Content-Length:`-header framing used by LSP-style servers.
//   • http  — we POST JSON-RPC to `{url}` (Streamable HTTP). Responses may come back
//     as plain application/json OR as a text/event-stream (SSE); both are handled,
//     along with the optional Mcp-Session-Id header.
//
// Design: STATELESS and SAFE. Every call runs a fresh, short handshake
// (initialize → notifications/initialized → the request) and, for stdio, spawns a
// throwaway process that is killed the moment we have the answer. No long-lived
// children, no shared sockets. Every path is bounded by a timeout so a broken or
// absent server can never hang the caller — it fails fast with a clear Error.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Resolve a bare command to a launchable file on Windows WITHOUT a shell. `spawn('npx', …)` fails
 * with ENOENT because npx is `npx.cmd`, and Node ≥18.20/20.12 blocks spawning `.cmd`/`.bat` without
 * a shell entirely. We keep shell:false (no metacharacter injection through model-supplied args) and
 * instead walk PATH × PATHEXT to find the real executable, exactly like a shell's lookup would.
 */
function resolveCommand(command: string): string {
  if (process.platform !== 'win32') return command;
  if (command.includes('/') || command.includes('\\') || path.extname(command)) return command; // already qualified
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return command; // not found — let spawn surface the ENOENT
}

export interface McpServer {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;   // stdio: executable to spawn
  args?: string[];    // stdio: its arguments
  url?: string;       // http: JSON-RPC endpoint
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export interface McpCallResult {
  text: string;        // joined text content (what Grace speaks/relays)
  isError: boolean;    // the tool itself reported an error result
}

const CLIENT_INFO = { name: 'grace', version: '1.0' };
const PROTOCOL_VERSION = '2024-11-05';

// ── Public API ───────────────────────────────────────────────────────────────

/** Connect to `server`, handshake, and return its advertised tools. Throws on failure. */
export async function listTools(server: McpServer, timeoutMs = 15_000): Promise<McpTool[]> {
  const result = await execute(server, 'tools/list', {}, timeoutMs);
  const raw = Array.isArray((result as any)?.tools) ? (result as any).tools : [];
  return raw.map((t: any) => ({
    name: String(t?.name ?? ''),
    description: String(t?.description ?? ''),
    inputSchema: t?.inputSchema,
  })).filter((t: McpTool) => t.name);
}

/** Call `name` on `server` with `args`, returning the joined text content. Throws on failure. */
export async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<McpCallResult> {
  const result = await execute(server, 'tools/call', { name, arguments: args ?? {} }, timeoutMs);
  const content = Array.isArray((result as any)?.content) ? (result as any).content : [];
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === 'object') {
      if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      else if (typeof c.text === 'string') parts.push(c.text);
      else if (c.type === 'resource' && c.resource?.text) parts.push(String(c.resource.text));
      else parts.push(`[${c.type ?? 'content'}]`);
    }
  }
  let text = parts.join('\n').trim();
  if (!text && result !== undefined) text = safeStringify(result);
  return { text, isError: !!(result as any)?.isError };
}

// ── Transport dispatch ───────────────────────────────────────────────────────

/** Run a full handshake + one request against `server`, returning the JSON-RPC `result`. */
function execute(server: McpServer, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  if (server.transport === 'http') return httpExecute(server, method, params, timeoutMs);
  return stdioExecute(server, method, params, timeoutMs);
}

// ── HTTP transport ───────────────────────────────────────────────────────────

async function httpExecute(server: McpServer, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  if (!server.url) throw new Error(`server '${server.name}' has no url`);
  const url = server.url;
  const started = Date.now();
  const remaining = () => Math.max(1_000, timeoutMs - (Date.now() - started));

  // 1) initialize
  const init = await httpPost(url, undefined, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  }, remaining());
  const initMsg = pickById(init.messages, 1);
  if (initMsg?.error) throw new Error(`initialize failed: ${errText(initMsg.error)}`);
  const sessionId = init.sessionId;

  // 2) notifications/initialized (best-effort; some servers return 202 with no body)
  await httpPost(url, sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' }, remaining()).catch(() => { /* noop */ });

  // 3) the actual request
  const res = await httpPost(url, sessionId, { jsonrpc: '2.0', id: 2, method, params }, remaining());
  const msg = pickById(res.messages, 2);
  if (!msg) throw new Error(`no JSON-RPC response for ${method}`);
  if (msg.error) throw new Error(`${method} failed: ${errText(msg.error)}`);
  return msg.result;
}

interface HttpPostResult { messages: any[]; sessionId?: string; }

async function httpPost(url: string, sessionId: string | undefined, body: unknown, timeoutMs: number): Promise<HttpPostResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const sid = res.headers.get('mcp-session-id') ?? undefined;

  if (res.status === 202 || res.status === 204) return { messages: [], sessionId: sid };
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${t ? ` — ${t.slice(0, 200)}` : ''}`);
  }

  const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
  const raw = await res.text();
  let messages: any[];
  if (ctype.includes('text/event-stream')) messages = parseSse(raw);
  else if (raw.trim()) {
    const parsed = tryJson(raw);
    if (parsed === undefined) throw new Error(`non-JSON response: ${raw.slice(0, 160)}`);
    messages = Array.isArray(parsed) ? parsed : [parsed];
  } else messages = [];
  return { messages: messages.filter((m) => m && typeof m === 'object'), sessionId: sid };
}

/** Extract JSON-RPC messages from an SSE stream (collects each event's `data:` lines). */
function parseSse(raw: string): any[] {
  const out: any[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data) continue;
    const parsed = tryJson(data);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

// ── stdio transport ──────────────────────────────────────────────────────────

function stdioExecute(server: McpServer, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!server.command) { reject(new Error(`server '${server.name}' has no command`)); return; }

    let child;
    try {
      child = spawn(resolveCommand(server.command), server.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      reject(new Error(`failed to spawn '${server.command}': ${String(e)}`));
      return;
    }

    const parser = new MessageParser();
    let settled = false;
    let phase: 'init' | 'call' = 'init';
    let stderr = '';

    const timer = setTimeout(() => fail(new Error(`MCP server '${server.name}' timed out after ${timeoutMs}ms${stderrTail()}`)), timeoutMs);

    const stderrTail = () => (stderr.trim() ? ` (stderr: ${stderr.trim().slice(-200)})` : '');
    const cleanup = () => { clearTimeout(timer); try { child.kill(); } catch { /* noop */ } };
    const fail = (err: Error) => { if (settled) return; settled = true; cleanup(); reject(err); };
    const succeed = (val: unknown) => { if (settled) return; settled = true; cleanup(); resolve(val); };

    const send = (obj: unknown) => {
      try { child.stdin?.write(JSON.stringify(obj) + '\n'); }
      catch (e) { fail(new Error(`write to '${server.name}' failed: ${String(e)}`)); }
    };

    const handle = (msgs: any[]) => {
      for (const m of msgs) {
        if (!m || typeof m !== 'object') continue;
        const id = typeof m.id === 'string' && /^\d+$/.test(m.id) ? Number(m.id) : m.id;
        if (id === 1 && phase === 'init') {
          if (m.error) { fail(new Error(`initialize failed: ${errText(m.error)}`)); return; }
          phase = 'call';
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method, params });
        } else if (id === 2) {
          if (m.error) { fail(new Error(`${method} failed: ${errText(m.error)}`)); return; }
          succeed(m.result);
          return;
        }
      }
    };

    child.on('error', (err) => fail(new Error(`spawn error for '${server.command}': ${String(err)}`)));
    child.stderr?.on('data', (d) => { stderr += d.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    child.stdout?.on('data', (chunk: Buffer) => { try { handle(parser.push(chunk)); } catch { /* keep reading */ } });
    child.on('close', (code) => {
      if (settled) return;
      try { handle(parser.flush()); } catch { /* noop */ }
      fail(new Error(`MCP server '${server.name}' exited (code ${code}) before responding${stderrTail()}`));
    });

    // Kick off the handshake.
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } });
  });
}

// Incremental parser for a stdio stream: understands BOTH newline-delimited JSON and
// `Content-Length:`-header framing, tolerating non-JSON noise lines (e.g. stray logs).
class MessageParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): any[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    return this.drain();
  }

  /** Parse whatever remains (for a final line without a trailing newline on close). */
  flush(): any[] {
    const out = this.drain();
    const tail = this.buf.toString('utf8').trim();
    this.buf = Buffer.alloc(0);
    if (tail) { const p = tryJson(tail); if (p !== undefined) out.push(p); }
    return out;
  }

  private drain(): any[] {
    const out: any[] = [];
    for (;;) {
      // Skip leading whitespace/newlines.
      let start = 0;
      while (start < this.buf.length && isWs(this.buf[start]!)) start++;
      if (start) this.buf = this.buf.subarray(start);
      if (this.buf.length === 0) break;

      const head = this.buf.subarray(0, 15).toString('latin1').toLowerCase();
      if (head.startsWith('content-length')) {
        const bodyStart = this.headerBodyStart();
        if (bodyStart < 0) break; // header not fully received yet
        const header = this.buf.subarray(0, bodyStart).toString('utf8');
        const m = /content-length:\s*(\d+)/i.exec(header);
        if (!m) { this.buf = this.buf.subarray(bodyStart); continue; } // malformed header, drop it
        const len = parseInt(m[1]!, 10);
        if (this.buf.length < bodyStart + len) break; // body not fully received yet
        const body = this.buf.subarray(bodyStart, bodyStart + len).toString('utf8');
        this.buf = this.buf.subarray(bodyStart + len);
        const p = tryJson(body);
        if (p !== undefined) out.push(p);
        continue;
      }

      // Newline-delimited JSON.
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) break; // wait for a complete line
      const line = this.buf.subarray(0, nl).toString('utf8').trim();
      this.buf = this.buf.subarray(nl + 1);
      if (line) { const p = tryJson(line); if (p !== undefined) out.push(p); }
    }
    return out;
  }

  /** Index where the body starts after a header block (`\r\n\r\n` or `\n\n`), or -1. */
  private headerBodyStart(): number {
    const crlf = this.buf.indexOf('\r\n\r\n');
    const lf = this.buf.indexOf('\n\n');
    let idx = -1; let sep = 0;
    if (crlf >= 0) { idx = crlf; sep = 4; }
    if (lf >= 0 && (idx < 0 || lf < idx)) { idx = lf; sep = 2; }
    return idx < 0 ? -1 : idx + sep;
  }
}

// ── small helpers ────────────────────────────────────────────────────────────

function isWs(b: number): boolean { return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d; }

function tryJson(s: string): any {
  try { return JSON.parse(s); } catch { return undefined; }
}

function pickById(messages: any[], id: number): any {
  return messages.find((m) => m && (m.id === id || m.id === String(id))) ?? messages.find((m) => m && (m.result !== undefined || m.error !== undefined));
}

function errText(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as any;
    return `${e.message ?? 'error'}${e.code !== undefined ? ` (code ${e.code})` : ''}`;
  }
  return String(err);
}

function safeStringify(v: unknown): string {
  try { const s = JSON.stringify(v); return s.length > 4000 ? s.slice(0, 4000) + '…' : s; }
  catch { return String(v); }
}
