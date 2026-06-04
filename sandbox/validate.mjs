// Runs INSIDE the sandbox container. Builds + smoke-tests one candidate tool in
// isolation and prints a single `VERDICT {json}` line; exits 0 (pass) / 1 (fail).
//
// Inputs (env): TOOL_NAME, TOOL_SRC_B64 (base64 of the .ts source), SMOKE (optional JSON args).
// There is NO host filesystem here and (by default) no network, so executing the
// candidate's run() during the smoke test is safe.
import fs from 'fs';
import { execSync } from 'child_process';

const name = process.env.TOOL_NAME || '';
const smoke = process.env.SMOKE || '';
const b64 = process.env.TOOL_SRC_B64 || '';

const verdict = (v) => { console.log('VERDICT ' + JSON.stringify(v)); process.exit(v.ok ? 0 : 1); };

if (!/^[a-z][a-z0-9_]*$/.test(name)) verdict({ ok: false, stage: 'input', error: `invalid tool name '${name}'` });
if (!b64) verdict({ ok: false, stage: 'input', error: 'no TOOL_SRC_B64 provided' });
const src = Buffer.from(b64, 'base64').toString('utf-8');
if (!/registerTool\s*\(/.test(src)) verdict({ ok: false, stage: 'input', error: 'source does not call registerTool()' });

// Drop the candidate into the framework copy and wire its import.
fs.writeFileSync(`src/tools/${name}.ts`, src);
let idx = fs.readFileSync('src/index.ts', 'utf-8');
if (!idx.includes(`./tools/${name}.js`)) {
  const re = /(import '\.\/tools\/[^']+\.js';\s*\n)(?![\s\S]*import '\.\/tools\/)/;
  idx = re.test(idx) ? idx.replace(re, `$1import './tools/${name}.js';\n`) : idx + `\nimport './tools/${name}.js';\n`;
  fs.writeFileSync('src/index.ts', idx);
}

// Build.
try {
  execSync('npx tsc -p tsconfig.json', { stdio: 'pipe' });
} catch (e) {
  const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.toString();
  const errs = out.split('\n').filter(l => /error TS\d|\.ts[:(]\d/.test(l)).slice(-15).join('\n');
  verdict({ ok: false, stage: 'build', error: errs || out.slice(-1000) });
}

// Register + smoke-run (executes the candidate's code — safe in here).
try {
  const mod = await import('/app/dist/index.js?t=' + Date.now());
  const names = mod.listTools().map(t => t.name);
  if (!names.includes(name)) verdict({ ok: false, stage: 'register', error: `did not self-register (got: ${names.join(',')})` });
  let smokeResult = null;
  if (smoke) {
    smokeResult = await mod.runTool(name, JSON.parse(smoke));
    if (smokeResult && typeof smokeResult === 'object' && smokeResult.error)
      verdict({ ok: false, stage: 'smoke', error: String(smokeResult.error), smoke: smokeResult });
  }
  verdict({ ok: true, stage: 'done', registered: true, tools: names.length, smoke: smokeResult });
} catch (e) {
  verdict({ ok: false, stage: 'smoke', error: String((e && e.stack) || e) });
}
