import { registerTool } from '../registry.js';

// Grace authors a NEW tool for herself. The source is built AND run in the isolated
// Docker sandbox first (scripts/sandbox-tool.mjs). If it passes and is pure-compute it
// auto-promotes into the real toolset; if it touches files or the network it asks Mikkel
// to confirm (call again with confirm:true). See docs/auto-develop.md. Requires Docker.
registerTool({
  name: 'create_tool',
  description: 'Create a NEW tool to extend your own capabilities. Give a snake_case name and the full TypeScript source of a tool file (it must `import { registerTool } from "../registry.js"` and call registerTool({ name, description, params, async run(args){...} })). It is built and test-run in an isolated Docker sandbox first. Pure-compute tools are added automatically; tools that touch files or the network are only added after Mikkel confirms (then call again with confirm:true). Optionally pass smoke_args to test-run it once.',
  params: {
    name: { type: 'string', description: 'snake_case tool name, e.g. "roll_dice"', required: true },
    source: { type: 'string', description: 'full TypeScript source of the tool file (imports registerTool from "../registry.js" and calls it)', required: true },
    smoke_args: { type: 'string', description: 'optional JSON args to test-run the tool once in the sandbox, e.g. {"sides":6}' },
    confirm: { type: 'boolean', description: 'set true ONLY after Mikkel approved adding a tool that touches files or the network' },
  },
  async run(args) {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const { spawn } = await import('child_process');
    const { fileURLToPath } = await import('url');

    const name = String(args.name ?? '').trim();
    if (!/^[a-z][a-z0-9_]*$/.test(name)) return { error: `invalid tool name '${name}' (snake_case: [a-z][a-z0-9_]*)` };
    const source = String(args.source ?? '');
    if (!/registerTool\s*\(/.test(source)) return { error: 'source must import registerTool and call registerTool({...})' };

    const repoRoot = process.env.GRACE_REPO_ROOT
      ? path.resolve(process.env.GRACE_REPO_ROOT)
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const sandboxScript = path.join(repoRoot, 'scripts', 'sandbox-tool.mjs');

    // Risk gate: does the tool touch the filesystem / processes / the network?
    const risky = /\b(fs|child_process|node:fs|node:child_process|net|http|https|dgram|fetch|spawn|exec|writeFile|unlink|process\.env|os\.homedir)\b/.test(source);
    const promote = !risky || args.confirm === true;

    const tmp = path.join(os.tmpdir(), `grace-create-${name}-${Date.now()}.ts`);
    await fs.writeFile(tmp, source, 'utf-8');

    const runArgs = [sandboxScript, name, '--from', tmp];
    if (args.smoke_args) runArgs.push('--smoke', String(args.smoke_args));
    if (promote) runArgs.push('--promote');

    const { code, out } = await new Promise<{ code: number; out: string }>((resolve) => {
      const ps = spawn(process.execPath, runArgs, {
        cwd: repoRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      let buf = '';
      ps.stdout.on('data', (d) => { buf += d.toString(); });
      ps.stderr.on('data', (d) => { buf += d.toString(); });
      ps.on('close', (c) => resolve({ code: c ?? 1, out: buf }));
      ps.on('error', (e) => resolve({ code: 1, out: String(e) }));
    });
    await fs.unlink(tmp).catch(() => {});

    const m = out.match(/SANDBOX_RESULT (\{.*\})/);
    let verdict: any = null;
    try { verdict = m ? JSON.parse(m[1]) : null; } catch { /* ignore */ }

    if (!verdict || !verdict.ok) {
      return {
        ok: false, promoted: false, stage: verdict?.stage,
        error: verdict?.error || ('sandbox failed: ' + out.slice(-400)),
        hint: 'fix the source based on the error and call create_tool again',
      };
    }
    if (!promote) {
      return {
        ok: true, promoted: false, needs_confirmation: true,
        reason: 'this tool touches files or the network',
        message: `'${name}' passed the sandbox, but it touches files or the network so I won't add it without your OK. Say yes and I'll add it (confirm:true).`,
      };
    }
    if (code !== 0) {
      return { ok: true, promoted: false, error: 'passed the sandbox but failed to promote into the real tree: ' + out.slice(-400) };
    }
    return { ok: true, promoted: true, tool: name, message: `'${name}' passed the sandbox and is now in my toolset (active after the next restart).` };
  },
});
