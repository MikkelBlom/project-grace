#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// sandbox-tool.mjs — host driver for the Docker tool sandbox (ROADMAP P5).
//
// Validates a candidate Grace tool by building + running it inside an ephemeral,
// isolated container (no host filesystem, no network by default, resource-capped),
// then OPTIONALLY promotes it into the real tree via scaffold-tool.mjs.
//
//   node scripts/sandbox-tool.mjs <name> --from <file.ts> [--smoke '{"a":1}']
//        [--allow-net]   # let the container reach the network (for tools that need it)
//        [--promote]     # on pass, add the tool to the real packages/tools tree
//        [--rebuild]     # rebuild the sandbox image (after changing the tools framework)
//
// This is the safe-execution layer Grace's auto-develop loop calls before plugging
// in self-written tools. See docs/auto-develop.md.
// ─────────────────────────────────────────────────────────────────────────────
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'grace-tool-sandbox';
const args = process.argv.slice(2);
const die = (m) => { console.error('[sandbox] ✗', m); process.exit(1); };
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : undefined; };

const name = args[0];
if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) die(`invalid tool name '${name}' (snake_case: [a-z][a-z0-9_]*)`);
const from = opt('--from');
if (!from || !fs.existsSync(from)) die('provide --from <file.ts> (an existing tool source file)');
const smoke = opt('--smoke');

const dockerOk = () => { try { execSync('docker version', { stdio: 'ignore' }); return true; } catch { return false; } };
const imageExists = () => { try { execSync(`docker image inspect ${IMAGE}`, { stdio: 'ignore' }); return true; } catch { return false; } };
function buildImage() {
  console.log('[sandbox] building image (first run / --rebuild)…');
  execSync(`docker build -f sandbox/Dockerfile -t ${IMAGE} .`, { cwd: ROOT, stdio: 'inherit' });
}

if (!dockerOk()) die('Docker is not available — is Docker Desktop running?');
if (flag('--rebuild') || !imageExists()) buildImage();

const srcB64 = Buffer.from(fs.readFileSync(path.resolve(from))).toString('base64');
const dArgs = ['run', '--rm', '--memory=1g', '--cpus=2', '--pids-limit=256',
  ...(flag('--allow-net') ? [] : ['--network', 'none']),
  '-e', `TOOL_NAME=${name}`,
  '-e', `TOOL_SRC_B64=${srcB64}`,
  ...(smoke ? ['-e', `SMOKE=${smoke}`] : []),
  IMAGE];
const r = spawnSync('docker', dArgs, { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
const m = out.match(/VERDICT (\{.*\})/);
const verdict = m ? JSON.parse(m[1]) : { ok: false, error: 'no verdict from sandbox; raw output:\n' + out.slice(-1500) };
console.log('[sandbox] verdict:\n' + JSON.stringify(verdict, null, 2));
console.log('SANDBOX_RESULT ' + JSON.stringify(verdict));  // machine-readable line for create_tool

if (verdict.ok && flag('--promote')) {
  console.log('[sandbox] ✓ passed in sandbox → promoting to the real tree…');
  const smokePart = smoke ? ['--smoke', smoke] : [];
  // --force so a sandbox-validated UPDATE can overwrite an existing tool of the same name.
  const p = spawnSync('node', ['scripts/scaffold-tool.mjs', 'add', name, '--from', path.resolve(from), '--force', ...smokePart], { cwd: ROOT, stdio: 'inherit' });
  process.exit(p.status ?? 0);
}
process.exit(verdict.ok ? 0 : 1);
