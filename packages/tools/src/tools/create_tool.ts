import { registerTool, listTools } from '../registry.js';

// Risky tools that PASSED the sandbox and are awaiting Mikkel's explicit OK. A risky tool
// only promotes on a genuine SECOND call (confirm:true) once it's already in this set — so the
// model can't bypass the gate by just setting confirm:true on the first attempt.
const pendingRisky = new Set<string>();

// Grace authors (or updates) a tool for herself. Built + run in the Docker sandbox first;
// pure-compute tools auto-promote, file/network tools wait for Mikkel's confirmation.
registerTool({
  name: 'create_tool',
  description: 'Create OR update a tool to extend your own capabilities. FIRST check your existing tools (listed above) — if one already does this, reuse or extend it instead of building a near-duplicate (e.g. don\'t add another dice/coin/random tool). Give a snake_case name and the full TypeScript source (it must `import { registerTool } from "../registry.js"` and call registerTool({ name, description, params, async run(args, ctx){...} }); to call another tool from inside, use `await ctx.callTool("web_search", { query })`). It is built and test-run in an isolated Docker sandbox first. Pure-compute tools are added automatically. Tools that touch files or the network are NOT added until Mikkel approves: you get needs_confirmation, then you ASK him and WAIT — only after he says yes do you call create_tool again with confirm:true. Requires Docker.',
  params: {
    name: { type: 'string', description: 'snake_case tool name, e.g. "roll_dice"', required: true },
    source: { type: 'string', description: 'full TypeScript source of the tool file', required: true },
    smoke_args: { type: 'string', description: 'optional JSON args to test-run the tool once in the sandbox, e.g. {"sides":6}' },
    confirm: { type: 'boolean', description: 'ONLY set true after Mikkel approved (in a PREVIOUS turn) a file/network tool — never on the first attempt' },
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

    const isUpdate = listTools().some(t => t.name === name);

    const repoRoot = process.env.GRACE_REPO_ROOT
      ? path.resolve(process.env.GRACE_REPO_ROOT)
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const sandboxScript = path.join(repoRoot, 'scripts', 'sandbox-tool.mjs');

    const risky = /\b(fs|child_process|node:fs|node:child_process|net|http|https|dgram|fetch|spawn|exec|writeFile|unlink|process\.env|os\.homedir)\b/.test(source);
    const needsNet = /\b(fetch|http|https|web_search|news_fetcher|fetch_url|axios)\b/.test(source);

    // Confirm gate: a risky tool promotes ONLY on a genuine second call (already surfaced + confirmed).
    // Setting confirm:true on the first attempt is ignored (name not yet pending).
    const promote = !risky || (args.confirm === true && pendingRisky.has(name));

    const tmp = path.join(os.tmpdir(), `grace-create-${name}-${Date.now()}.ts`);
    await fs.writeFile(tmp, source, 'utf-8');

    const runArgs = [sandboxScript, name, '--from', tmp];
    // smoke_args may arrive as a JSON string OR as an object (the model often emits an object).
    // String(obj) would give "[object Object]" → the sandbox's JSON.parse then fails and wastes
    // retries, so stringify objects properly here.
    if (args.smoke_args != null && args.smoke_args !== '') {
      const smoke = typeof args.smoke_args === 'string' ? args.smoke_args : JSON.stringify(args.smoke_args);
      runArgs.push('--smoke', smoke);
    }
    if (needsNet) runArgs.push('--allow-net');   // so the smoke test can actually exercise the network
    if (promote) runArgs.push('--promote');

    const { code, out } = await new Promise<{ code: number; out: string }>((resolve) => {
      const ps = spawn(process.execPath, runArgs, { cwd: repoRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
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
      pendingRisky.add(name);   // now eligible to be confirmed on a later turn
      return {
        ok: true, promoted: false, needs_confirmation: true,
        reason: 'this tool touches files or the network',
        message: `'${name}' passed the sandbox, but it touches files or the network. STOP and ASK Mikkel to approve it — do NOT retry now. Only after he says yes, call create_tool again with confirm:true.`,
      };
    }
    pendingRisky.delete(name);
    if (code !== 0) {
      return { ok: true, promoted: false, error: 'passed the sandbox but failed to promote into the real tree: ' + out.slice(-400) };
    }

    // ── Hot reload ────────────────────────────────────────────────────────
    // The promote built packages/tools/dist/tools/<name>.js. Dynamically import
    // it NOW so its registerTool() side-effect lands in the live registry singleton
    // (the same Map OllamaLLM reads via describeTools/runTool) — no restart needed.
    // A cache-busting query forces a fresh module eval so UPDATES take effect too.
    let live = false;
    let hotLoadError: string | undefined;
    try {
      const { pathToFileURL } = await import('url');
      const distFile = path.join(repoRoot, 'packages', 'tools', 'dist', 'tools', `${name}.js`);
      await import(`${pathToFileURL(distFile).href}?t=${Date.now()}`);
      live = listTools().some(t => t.name === name);
      if (!live) hotLoadError = 'imported but did not self-register';
    } catch (e) {
      hotLoadError = String(e);
    }

    return {
      ok: true, promoted: true, tool: name, updated: isUpdate, live,
      message: live
        ? `'${name}' passed the sandbox and is ${isUpdate ? 'updated' : 'added'} in my toolset — live RIGHT NOW, no restart needed. You can call it this turn.`
        : `'${name}' passed the sandbox and is ${isUpdate ? 'updated' : 'added'} in my toolset, but hot-load failed (${hotLoadError}); it will be active after the next restart.`,
    };
  },
});
