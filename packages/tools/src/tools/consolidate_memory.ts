import { graceMemory } from '@grace/core';
import { registerTool } from '../registry.js';

// Tidy Grace's semantic memory — drop exact-duplicate records (keeping the newest copy).
registerTool({
  name: 'consolidate_memory',
  description: "Clean up Grace's long-term memory by removing duplicate records (keeps the newest copy of each). Use when memory feels cluttered or Mikkel asks Grace to tidy her memory.",
  params: {},
  async run() {
    const r = graceMemory.consolidate();
    return { ok: true, before: r.before, after: r.after, removed: r.removed };
  },
});
