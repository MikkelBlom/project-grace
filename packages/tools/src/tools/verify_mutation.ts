import fs from 'fs';
import { graceMemory } from '@grace/core';
import { registerTool } from '../registry.js';

function checkPath(p: string){
  try {
    const st = fs.statSync(p);
    return { exists: true, size: st.size };
  } catch (e) {
    return { exists: false, error: String(e) };
  }
}

registerTool({
  name: 'verify_mutation',
  description: 'Verify files/folders changed by previous mutating tools. Returns existence and size checks and records verification in the scratchpad.',
  params: { paths: { type: 'string', description: 'one or multiple paths separated by newlines or pipes' } },
  async run(args) {
    const raw = typeof args.paths === 'string' ? args.paths : '';
    const paths = raw.split(/\r?\n|\s*\|\s*|;+/).map(s => s.trim()).filter(Boolean);
    if (!paths.length) return { ok: false, error: 'no paths provided' };
    const results: any = {};
    for (const p of paths) results[p] = checkPath(p);
    const notes = Object.entries(results).map(([p, r]) => `verified: ${p} -> ${JSON.stringify(r)}`);
    graceMemory.updateScratchpad({ verification: notes }, 'verify_mutation');
    return { ok: true, results };
  }
});
