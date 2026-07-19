// Grace eval harness — drives the REAL turn (through the tool loop) for each prompt and scores
// latency + a light correctness signal, so model/harness changes can be judged by data.
//
//   npm run eval          # full run (needs Ollama up + the model pulled)
//   npm run eval -- --dry # list the set + check Ollama reachability, no LLM calls
//
// Correctness is intentionally lenient (spoken assistant, not exact strings): expectContainsAny,
// expectToolAny, expectNotTool, maxLatencyMs. Keep the set small + stable for comparability.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLLAMA_URL = process.env.GRACE_OLLAMA_URL ?? 'http://localhost:11434';
const DRY = process.argv.includes('--dry');

const { prompts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'prompts.json'), 'utf8'));

async function ollamaUp() {
  try { const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) }); return r.ok; } catch { return false; }
}

if (DRY) {
  const cats = [...new Set(prompts.map((p) => p.category))];
  console.log(`Eval set: ${prompts.length} prompts | categories: ${cats.join(', ')}`);
  console.log(`Ollama reachable at ${OLLAMA_URL}: ${await ollamaUp()}`);
  for (const p of prompts) console.log(`  [${p.category}] ${p.id}: "${p.prompt.slice(0, 60)}"`);
  process.exit(0);
}

if (!(await ollamaUp())) {
  console.error(`Ollama not reachable at ${OLLAMA_URL}. Start it (or set GRACE_OLLAMA_URL) and retry.`);
  process.exit(1);
}

// Load the real pipeline from the built dist.
await import(path.join(ROOT, 'packages/tools/dist/index.js'));
const { bus } = await import(path.join(ROOT, 'packages/core/dist/index.js'));
const { OllamaLLM } = await import(path.join(ROOT, 'packages/llm/dist/OllamaLLM.js'));
new OllamaLLM();

// A persistent listener routes events to the currently-running prompt (the bus has no off()).
let current = null;
bus.on('tool:execute', (c) => { if (current && c?.name) current.toolsUsed.push(c.name); });
bus.on('llm:response', (r) => { if (current) { current.finalText = r?.text ?? ''; current.finish(false); } });

function runPrompt(p) {
  return new Promise((resolve) => {
    const start = Date.now();
    const ctx = { toolsUsed: [], finalText: '', finish: null };
    const timer = setTimeout(() => ctx.finish(true), 90_000);
    ctx.finish = (timeout) => {
      clearTimeout(timer);
      const r = { finalText: ctx.finalText, toolsUsed: ctx.toolsUsed.slice(), latencyMs: Date.now() - start, timeout };
      current = null;
      resolve(r);
    };
    current = ctx;
    bus.emit('llm:thinking', { sessionId: `eval-${p.id}`, text: p.prompt, history: [] });
  });
}

function score(p, res) {
  const reasons = [];
  const textLc = (res.finalText || '').toLowerCase();
  if (p.expectContainsAny && !p.expectContainsAny.some((s) => textLc.includes(String(s).toLowerCase()))) reasons.push(`reply missing any of [${p.expectContainsAny}]`);
  if (p.expectToolAny && !p.expectToolAny.some((t) => res.toolsUsed.includes(t))) reasons.push(`no tool of [${p.expectToolAny}] (ran: ${res.toolsUsed.join(',') || 'none'})`);
  if (p.expectNotTool && p.expectNotTool.some((t) => res.toolsUsed.includes(t))) reasons.push(`ran forbidden tool of [${p.expectNotTool}] (ran: ${res.toolsUsed.join(',')})`);
  if (p.maxLatencyMs && res.latencyMs > p.maxLatencyMs) reasons.push(`slow ${res.latencyMs}ms > ${p.maxLatencyMs}ms`);
  if (res.timeout) reasons.push('TIMEOUT (90s)');
  return { pass: reasons.length === 0, reasons };
}

const results = [];
for (const p of prompts) {
  process.stdout.write(`[${p.category}] ${p.id} ... `);
  const res = await runPrompt(p);
  const sc = score(p, res);
  results.push({ p, res, sc });
  console.log(`${sc.pass ? 'PASS' : 'FAIL'} ${res.latencyMs}ms${sc.pass ? '' : '  — ' + sc.reasons.join('; ')}`);
}

const pass = results.filter((r) => r.sc.pass).length;
const lat = results.map((r) => r.res.latencyMs).sort((a, b) => a - b);
const p50 = lat[Math.floor(lat.length / 2)] ?? 0;
const byCat = {};
for (const r of results) { (byCat[r.p.category] ??= { pass: 0, total: 0 }).total++; if (r.sc.pass) byCat[r.p.category].pass++; }
console.log('\n--- by category ---');
for (const [c, s] of Object.entries(byCat)) console.log(`  ${c}: ${s.pass}/${s.total}`);
console.log(`\n=== ${pass}/${results.length} passed | latency p50 ${p50}ms | max ${lat[lat.length - 1] ?? 0}ms ===`);
process.exit(pass === results.length ? 0 : 1);
