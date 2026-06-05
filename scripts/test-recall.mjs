import { runTool } from '../packages/tools/dist/index.js';

async function main(){
  console.log('Calling recall_memory with query="favorite editor"...');
  const res = await runTool('recall_memory', { query: 'What is Mikkel\'s preferred editor or coding style?', limit: 6, recencyWeight: 0.35 });
  console.log('Result:', JSON.stringify(res, null, 2));
}

main().catch(err=>{ console.error(err); process.exit(1); });
