// Smoke test: load every tool and assert the registry is healthy (no import crash, all tools
// well-formed, no duplicate names). Run: npm run smoke  (after npm run build).
import assert from 'node:assert/strict';

await import('../packages/tools/dist/index.js');
const { listTools } = await import('../packages/tools/dist/registry.js');
const tools = listTools();

assert.ok(tools.length > 30, `expected >30 tools, got ${tools.length}`);
for (const t of tools) {
  assert.ok(typeof t.name === 'string' && t.name, 'tool missing name');
  assert.ok(typeof t.description === 'string' && t.description.length > 10, `tool ${t.name} has a weak description`);
  assert.ok(typeof t.run === 'function', `tool ${t.name} missing run()`);
  assert.ok(t.params && typeof t.params === 'object', `tool ${t.name} missing params object`);
}
const names = tools.map((t) => t.name);
assert.equal(new Set(names).size, names.length, 'duplicate tool names found');

console.log(`smoke OK: ${tools.length} tools registered, all well-formed, no duplicates`);
