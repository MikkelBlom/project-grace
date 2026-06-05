import assert from 'assert';
import { runTool } from '../packages/tools/dist/index.js';

async function main(){
  const res = await runTool('recall_memory', { query: 'test recall structure', limit: 4 });
  assert(res && typeof res === 'object', 'no response object');
  assert(res && res.ok === true, 'ok flag not true');
  const hits = res.hits;
  assert(Array.isArray(hits), 'hits is not array');
  for (const h of hits){
    assert(h && h.id, 'hit missing id');
    assert(typeof h.score === 'number', 'hit missing score');
    assert(h.summary !== undefined, 'hit missing summary');
  }
  console.log('recall_memory structure OK —', hits.length, 'hits');
}

main().catch(err=>{ console.error(err); process.exit(1); });
