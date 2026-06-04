#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scaffold-tool.mjs — safely add / remove a Grace tool.
//
// Writes the tool file, patches index.ts, runs the build, smoke-tests the tool,
// and AUTOMATICALLY REVERTS if the build (or smoke test) fails — so a broken
// generated tool can never leave the source tree in a non-building state.
//
// This is the validation harness behind Grace's auto-develop workflow
// (ROADMAP P5: generate → test → plug in) and a convenience for human/AI authors.
//
// Usage:
//   node scripts/scaffold-tool.mjs add <name> --from <file.ts>  [--smoke '{"a":1}'] [--force] [--keep-on-fail]
//   node scripts/scaffold-tool.mjs add <name> --stdin           [--smoke '...'] [--force] [--keep-on-fail]
//   node scripts/scaffold-tool.mjs add <name> --stub            (writes a minimal valid template)
//   node scripts/scaffold-tool.mjs remove <name>
//   node scripts/scaffold-tool.mjs list
//
// SAFETY: building/smoke-testing executes the tool's module-load + run() code with
// full Node privileges. Only run on tool source you (a human or a reviewing AI)
// have seen. Wiring this to voice-triggered, unreviewed code needs the sandbox
// in ROADMAP P4/P5 first.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TOOLS_DIR = path.join(ROOT, 'packages', 'tools', 'src', 'tools');
const INDEX = path.join(ROOT, 'packages', 'tools', 'src', 'index.ts');
const DIST_INDEX = path.join(ROOT, 'packages', 'tools', 'dist', 'index.js');

const log = (...a) => console.log('[scaffold]', ...a);
const die = (msg) => { console.error('[scaffold] ✗', msg); process.exit(1); };

const validName = (n) => /^[a-z][a-z0-9_]*$/.test(n);
const toolFile = (n) => path.join(TOOLS_DIR, `${n}.ts`);

const readIndex = () => fs.readFileSync(INDEX, 'utf-8');
const writeIndex = (s) => fs.writeFileSync(INDEX, s, 'utf-8');
const hasImport = (src, n) => new RegExp(`^import '\\./tools/${n}\\.js';$`, 'm').test(src);

function addImport(name) {
  let src = readIndex();
  if (hasImport(src, name)) return;
  const line = `import './tools/${name}.js';\n`;
  // Insert after the LAST `import './tools/*.js';` line.
  const re = /(import '\.\/tools\/[^']+\.js';\s*\n)(?![\s\S]*import '\.\/tools\/)/;
  src = re.test(src) ? src.replace(re, `$1${line}`) : src + `\n${line}`;
  writeIndex(src);
}
function removeImport(name) {
  writeIndex(readIndex().replace(new RegExp(`^import '\\./tools/${name}\\.js';\\s*\\n`, 'm'), ''));
}

function build() {
  try {
    execSync('npm run build', { cwd: ROOT, stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.toString();
    const lines = out.split('\n');
    // Prefer the actual compiler errors (file.ts(line,col): error TSxxxx) over npm's wrapper noise.
    const tsErrors = lines.filter(l => /error TS\d|: error\b|\.ts[:(]\d/i.test(l) && !/^npm error/i.test(l));
    return { ok: false, out: (tsErrors.length ? tsErrors : lines.filter(Boolean)).slice(-25).join('\n') || out.slice(-1500) };
  }
}

async function smoke(name, argsJson) {
  const mod = await import('file://' + DIST_INDEX.replace(/\\/g, '/') + '?t=' + Date.now());
  const names = mod.listTools().map(t => t.name);
  if (!names.includes(name)) throw new Error(`tool '${name}' did not self-register (got: ${names.join(', ')})`);
  log(`registered ✓ — ${names.length} tools total`);
  if (argsJson != null) {
    const res = await mod.runTool(name, JSON.parse(argsJson));
    log(`smoke run ${name}(${argsJson}) → ${JSON.stringify(res)}`);
    if (res && typeof res === 'object' && res.error) throw new Error(`smoke run returned an error: ${res.error}`);
  }
}

const STUB = (name) => `import { registerTool } from '../registry.js';

registerTool({
  name: '${name}',
  description: 'TODO: describe ${name} precisely so the model knows WHEN to use it.',
  params: {
    input: { type: 'string', description: 'what this takes', required: true },
  },
  async run(args) {
    const input = String(args.input ?? '');
    if (!input) return { error: 'input is required' };
    return { ok: true, echo: input };
  },
});
`;

function flag(args, name) { return args.includes(name); }
function opt(args, name) { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : undefined; }

async function cmdAdd(args) {
  const name = args[0];
  if (!name || !validName(name)) die(`invalid tool name '${name}' (use snake_case: [a-z][a-z0-9_]*)`);
  const file = toolFile(name);
  const force = flag(args, '--force');
  if (fs.existsSync(file) && !force) die(`${path.relative(ROOT, file)} already exists (use --force to overwrite)`);

  // Source: --stub | --from <file> | --stdin
  let source;
  if (flag(args, '--stub')) source = STUB(name);
  else if (opt(args, '--from')) source = fs.readFileSync(opt(args, '--from'), 'utf-8');
  else if (flag(args, '--stdin')) source = fs.readFileSync(0, 'utf-8');
  else die('provide source: --from <file.ts> | --stdin | --stub');
  if (!/registerTool\s*\(/.test(source)) die('source does not call registerTool() — not a valid tool file');

  const smokeArgs = opt(args, '--smoke');
  const keepOnFail = flag(args, '--keep-on-fail');

  const hadImport = hasImport(readIndex(), name);
  const existed = fs.existsSync(file);
  const revert = () => {
    if (!existed) { try { fs.unlinkSync(file); } catch {} }
    if (!hadImport) removeImport(name);
  };

  fs.writeFileSync(file, source, 'utf-8');
  addImport(name);
  log(`wrote ${path.relative(ROOT, file)} + import; building...`);

  const b = build();
  if (!b.ok) {
    if (!keepOnFail) { revert(); log('build failed → reverted (tree is clean)'); }
    die(`build failed:\n${b.out}`);
  }
  log('build ✓');

  try {
    await smoke(name, smokeArgs);
  } catch (e) {
    if (!keepOnFail) { revert(); build(); log('smoke failed → reverted + rebuilt (tree is clean)'); }
    die(`smoke test failed: ${e.message}`);
  }
  log(`✓ tool '${name}' added and validated.`);
}

function cmdRemove(args) {
  const name = args[0];
  if (!name || !validName(name)) die(`invalid tool name '${name}'`);
  const file = toolFile(name);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  removeImport(name);
  log(`removed ${name}; rebuilding...`);
  const b = build();
  if (!b.ok) die(`build failed after removal:\n${b.out}`);
  log(`✓ tool '${name}' removed.`);
}

async function cmdList() {
  if (!fs.existsSync(DIST_INDEX)) die('not built yet — run: npm run build');
  const mod = await import('file://' + DIST_INDEX.replace(/\\/g, '/'));
  const tools = mod.listTools();
  log(`${tools.length} tools:`);
  for (const t of tools) console.log(`  - ${t.name}: ${t.description.slice(0, 80)}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'add') await cmdAdd(rest);
else if (cmd === 'remove') cmdRemove(rest);
else if (cmd === 'list') await cmdList();
else die('usage: add <name> (--from <f>|--stdin|--stub) [--smoke <json>] [--force] [--keep-on-fail] | remove <name> | list');
