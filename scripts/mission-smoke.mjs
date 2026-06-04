#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// mission-smoke.mjs — pre-flight check before a real autonomous mission.
//
// Verifies the machine + the self-build chain WITHOUT needing voice or the LLM:
//   1. Docker present (create_tool's sandbox needs it)
//   2. Ollama + the model reachable
//   3. create_tool builds a tiny pure-compute tool in the Docker sandbox, promotes it,
//      and HOT-LOADS it live; then calls it to confirm it actually works
//   4. cleans the tool back out so the tree is left as it was
//
// Run from the grace/ root:  node scripts/mission-smoke.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { execSync } from 'child_process';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_INDEX = path.join(ROOT, 'packages', 'tools', 'dist', 'index.js');
const MODEL = process.env.GRACE_LLM_MODEL ?? 'gemma4:26b';
const NAME = 'smoke_adder';
let failures = 0;
const ok = (m) => console.log(`✅ ${m}`);
const bad = (m) => { console.log(`❌ ${m}`); failures++; };

console.log('— Grace mission pre-flight —\n');

// 0. On which branch? (commits only land if it's grace/*)
try {
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT }).toString().trim();
  if (branch.startsWith('grace/')) ok(`on branch ${branch} — auto-commit will work`);
  else console.log(`ℹ️  on branch ${branch} — fine for a dry run, but for the REAL mission checkout a grace/* branch so Grace can commit (git checkout -b grace/self-dev)`);
} catch { console.log('ℹ️  not a git repo? skipping branch check'); }

// 1. Docker
try { execSync('docker --version', { stdio: 'pipe' }); ok('Docker available'); }
catch { bad('Docker NOT found — create_tool sandbox cannot run. Start Docker Desktop.'); }

// 2. Ollama + model
try {
  const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(4000) });
  const d = await r.json();
  const names = (d.models ?? []).map(m => m.name);
  if (names.some(n => n.startsWith(MODEL.split(':')[0]))) ok(`Ollama up, ${MODEL} present`);
  else bad(`Ollama up but ${MODEL} not pulled (have: ${names.join(', ')})`);
} catch { bad('Ollama not reachable on :11434 — start it (ollama serve)'); }

// 3. Build + hot-load a tiny pure-compute tool through the real create_tool path
const source = `import { registerTool } from '../registry.js';
registerTool({
  name: '${NAME}',
  description: 'Add two numbers (smoke test tool).',
  params: { a: { type: 'number', description: 'first', required: true }, b: { type: 'number', description: 'second', required: true } },
  async run(args) { return { sum: Number(args.a) + Number(args.b) }; },
});
`;
let built = false;
try {
  const tools = await import(pathToFileURL(DIST_INDEX).href);
  console.log('\nBuilding smoke_adder via create_tool (Docker sandbox)… this can take ~30-60s');
  const res = await tools.runTool('create_tool', { name: NAME, source, smoke_args: '{"a":2,"b":3}' });
  console.log('   create_tool →', JSON.stringify(res));
  if (res?.promoted && res?.live) {
    ok('tool promoted AND hot-loaded live (no restart)');
    const call = await tools.runTool(NAME, { a: 2, b: 3 });
    if (call?.sum === 5) { ok('hot-loaded tool callable: smoke_adder(2,3) = 5'); built = true; }
    else bad(`tool returned unexpected result: ${JSON.stringify(call)}`);
  } else {
    bad(`create_tool did not promote+hotload: ${JSON.stringify(res)}`);
  }
} catch (e) { bad(`create_tool threw: ${e}`); }

// 4. Cleanup — remove the smoke tool so the tree is unchanged
try {
  execSync(`node scripts/scaffold-tool.mjs remove ${NAME}`, { cwd: ROOT, stdio: 'pipe' });
  ok('cleaned up smoke_adder');
} catch (e) {
  if (built) console.log(`⚠️  could not auto-remove ${NAME} — run: node scripts/scaffold-tool.mjs remove ${NAME}`);
}

console.log(`\n${failures === 0 ? '✅ ALL GREEN — ready for a real mission.' : `❌ ${failures} check(s) failed — fix before the mission.`}`);
process.exit(failures === 0 ? 0 : 1);
