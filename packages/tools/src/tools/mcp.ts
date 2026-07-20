// ─────────────────────────────────────────────────────────────────────────────
// MCP client tools — let Grace use ANY external Model Context Protocol server that
// Mikkel configures (filesystem, git, home-automation, a company API, …).
//
// Servers are saved to data/mcp-servers.json. Two transports are supported:
//   • stdio — a local command Grace spawns per call (initialize → request → kill).
//   • http  — a JSON-RPC endpoint Grace POSTs to.
// The heavy lifting (handshake, framing, timeouts) lives in lib/mcp.ts. Every tool
// here returns a structured {error} on failure and never hangs — all IO is bounded.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerTool } from '../registry.js';
import { listTools as mcpListTools, callTool as mcpCallTool, type McpServer } from '../lib/mcp.js';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CONFIG_PATH = path.join(ROOT, 'data', 'mcp-servers.json');

function loadServers(): McpServer[] {
  try {
    const d = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return Array.isArray(d?.servers) ? d.servers : [];
  } catch { return []; }
}

function saveServers(servers: McpServer[]): boolean {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ servers }, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

function findServer(name: string): McpServer | undefined {
  const n = name.trim().toLowerCase();
  return loadServers().find((s) => s.name.toLowerCase() === n);
}

/** Split a command-arguments STRING into an argv array, honouring simple "…"/'…' quoting. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** Accept args as an object, a JSON string, or empty → {}. Returns {error} on bad JSON. */
function coerceArgs(raw: unknown): { args?: Record<string, unknown>; error?: string } {
  if (raw == null || raw === '') return { args: {} };
  if (typeof raw === 'object' && !Array.isArray(raw)) return { args: raw as Record<string, unknown> };
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return { args: {} };
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { args: parsed as Record<string, unknown> };
      return { error: 'args must be a JSON object, e.g. {"path":"C:/x"}' };
    } catch { return { error: `args is not valid JSON: ${s.slice(0, 80)}` }; }
  }
  return { error: 'args must be a JSON object or JSON string' };
}

// ── mcp_add_server ───────────────────────────────────────────────────────────
registerTool({
  name: 'mcp_add_server',
  description: 'Save an external MCP (Model Context Protocol) server so Grace can use its tools later. Provide a name and EITHER command (a local program to run, stdio transport) OR url (an HTTP JSON-RPC endpoint). Adding a name that already exists overwrites it. Use when Mikkel wants to connect a new MCP server (filesystem, git, home automation, an API, etc.).',
  params: {
    name: { type: 'string', description: 'short unique name for this server, e.g. "filesystem"', required: true },
    command: { type: 'string', description: 'stdio transport: the executable to run, e.g. "npx" or "node"' },
    args: { type: 'string', description: 'stdio transport: arguments for the command as one string, e.g. "-y @modelcontextprotocol/server-filesystem C:/Users/mikke"' },
    url: { type: 'string', description: 'http transport: the JSON-RPC endpoint URL (use this INSTEAD of command)' },
  },
  async run(args) {
    const name = String(args.name ?? '').trim();
    if (!name) return { error: 'name is required' };
    const url = String(args.url ?? '').trim();
    const command = String(args.command ?? '').trim();

    let server: McpServer;
    if (url) {
      if (!/^https?:\/\//i.test(url)) return { error: 'url must start with http:// or https://' };
      server = { name, transport: 'http', url };
    } else if (command) {
      const argList = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : splitArgs(String(args.args ?? ''));
      server = { name, transport: 'stdio', command, args: argList };
    } else {
      return { error: 'provide either "command" (stdio) or "url" (http)' };
    }

    const servers = loadServers().filter((s) => s.name.toLowerCase() !== name.toLowerCase());
    const replaced = servers.length !== loadServers().length;
    servers.push(server);
    if (!saveServers(servers)) return { error: 'could not write data/mcp-servers.json' };
    return { ok: true, saved: server, replaced, note: `Server '${name}' saved. Use mcp_list_tools to see what it offers.` };
  },
});

// ── mcp_list_servers ─────────────────────────────────────────────────────────
registerTool({
  name: 'mcp_list_servers',
  description: 'List the external MCP servers Mikkel has configured (name, transport, and command/url). Use to see what MCP servers Grace can reach before listing or calling their tools.',
  params: {},
  async run() {
    const servers = loadServers();
    return {
      count: servers.length,
      servers: servers.map((s) => ({
        name: s.name,
        transport: s.transport,
        command: s.command,
        args: s.args,
        url: s.url,
      })),
    };
  },
});

// ── mcp_remove_server ────────────────────────────────────────────────────────
registerTool({
  name: 'mcp_remove_server',
  description: 'Remove a configured external MCP server by name (from mcp_list_servers). Use when Mikkel no longer wants Grace connected to that server.',
  params: {
    name: { type: 'string', description: 'the server name to remove', required: true },
  },
  async run(args) {
    const name = String(args.name ?? '').trim();
    if (!name) return { error: 'name is required' };
    const before = loadServers();
    const after = before.filter((s) => s.name.toLowerCase() !== name.toLowerCase());
    if (after.length === before.length) return { error: `no configured server named '${name}'` };
    if (!saveServers(after)) return { error: 'could not write data/mcp-servers.json' };
    return { ok: true, removed: name, remaining: after.length };
  },
});

// ── mcp_list_tools ───────────────────────────────────────────────────────────
registerTool({
  name: 'mcp_list_tools',
  description: 'Connect to one configured external MCP server and list the tools it exposes (name + description). Use this to discover what an MCP server can do before calling it with mcp_call. A broken or absent server returns a clear error, never a hang.',
  params: {
    server: { type: 'string', description: 'the configured server name (from mcp_list_servers)', required: true },
  },
  async run(args) {
    const name = String(args.server ?? '').trim();
    if (!name) return { error: 'server is required' };
    const server = findServer(name);
    if (!server) return { error: `no configured server named '${name}'. Add it with mcp_add_server first.` };
    try {
      const tools = await mcpListTools(server, 15_000);
      return {
        server: server.name,
        transport: server.transport,
        count: tools.length,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      };
    } catch (e) {
      return { error: `could not list tools from '${server.name}': ${String(e instanceof Error ? e.message : e)}` };
    }
  },
});

// ── mcp_call ─────────────────────────────────────────────────────────────────
registerTool({
  name: 'mcp_call',
  description: 'Call a specific tool on a configured external MCP server and get its text result. First use mcp_list_tools to learn the tool name and its arguments. This lets Grace use any external MCP server Mikkel has connected. A broken server or a failing tool returns a clear error, never a hang.',
  params: {
    server: { type: 'string', description: 'the configured server name (from mcp_list_servers)', required: true },
    tool: { type: 'string', description: 'the tool name to call (from mcp_list_tools)', required: true },
    args: { type: 'string', description: "arguments for the tool as a JSON object or JSON string, e.g. {\"path\":\"C:/Users/mikke/notes.txt\"} (omit if the tool needs none)" },
  },
  async run(args) {
    const name = String(args.server ?? '').trim();
    const tool = String(args.tool ?? '').trim();
    if (!name) return { error: 'server is required' };
    if (!tool) return { error: 'tool is required' };
    const server = findServer(name);
    if (!server) return { error: `no configured server named '${name}'. Add it with mcp_add_server first.` };

    const coerced = coerceArgs(args.args);
    if (coerced.error) return { error: coerced.error };

    try {
      const res = await mcpCallTool(server, tool, coerced.args ?? {}, 30_000);
      const text = res.text.length > 8000 ? res.text.slice(0, 8000) + '\n…[truncated]' : res.text;
      if (res.isError) return { ok: false, server: server.name, tool, isError: true, result: text || '(the tool reported an error with no message)' };
      return { ok: true, server: server.name, tool, result: text };
    } catch (e) {
      return { error: `mcp_call to '${server.name}'/${tool} failed: ${String(e instanceof Error ? e.message : e)}` };
    }
  },
});
