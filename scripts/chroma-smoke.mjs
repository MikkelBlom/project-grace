const CHROMA_URL = process.env.GRACE_CHROMA_URL || 'http://127.0.0.1:8000';
const OLLAMA_URL = process.env.GRACE_OLLAMA_URL || 'http://localhost:11434';
const COLLECTION = `grace_smoke_${Date.now()}`;

async function fetchJson(url, opts = {}){
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), ...opts });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function heartbeat(){
  const urls = [`${CHROMA_URL}/api/v1/heartbeat`, `${CHROMA_URL}/api/v2/heartbeat`, `${CHROMA_URL}/heartbeat`];
  for (const u of urls){
    try{ const r = await fetch(u, { signal: AbortSignal.timeout(3000) }); if (r.ok) return true; }catch(e){}
  }
  return false;
}

async function main(){
  console.log('Chroma URL:', CHROMA_URL);
  const alive = await heartbeat();
  console.log('Chroma heartbeat:', alive);
  if(!alive) throw new Error('Chroma not responding');

  console.log('Creating collection', COLLECTION);
  const created = await fetchJson(`${CHROMA_URL}/api/v1/collections`, { method: 'POST', body: JSON.stringify({ name: COLLECTION }), headers: { 'Content-Type': 'application/json' } });
  console.log('Create response:', created?.id ?? created);

  console.log('Requesting embedding from Ollama...');
  let embedding = null;
  try {
    const embResp = await fetchJson(`${OLLAMA_URL}/api/embeddings`, { method: 'POST', body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'hello world' }), headers: { 'Content-Type': 'application/json' } });
    embedding = embResp?.embedding ?? null;
    if (Array.isArray(embedding)) console.log('Embedding length:', embedding.length);
    else {
      console.warn('Ollama did not return embedding; falling back to synthetic vector.');
      embedding = null;
    }
  } catch (e) {
    console.warn('Embedding request failed:', e, '\nFalling back to synthetic vector.');
    embedding = null;
  }
  if (!Array.isArray(embedding)) {
    // Fallback: deterministic synthetic embedding so we can test Chroma add/query flow
    const dim = 384;
    embedding = new Array(dim).fill(0).map((_, i) => Math.sin(i + 1));
    console.log('Using synthetic embedding of length', embedding.length);
  }

  console.log('Adding document to Chroma...');
  const addRes = await fetchJson(`${CHROMA_URL}/api/v1/collections/${encodeURIComponent(COLLECTION)}/add`, {
    method: 'POST',
    body: JSON.stringify({ ids: ['smoke-1'], embeddings: [embedding], metadatas: [{ source: 'smoke' }], documents: ['hello world smoke test'] }),
    headers: { 'Content-Type': 'application/json' },
  });
  console.log('Add response:', addRes);

  console.log('Querying Chroma...');
  const q = await fetchJson(`${CHROMA_URL}/api/v1/collections/${encodeURIComponent(COLLECTION)}/query`, {
    method: 'POST',
    body: JSON.stringify({ query_embeddings: [embedding], n_results: 1, include: ['metadatas','documents','distances','ids'] }),
    headers: { 'Content-Type': 'application/json' },
  });
  console.log('Query response:', JSON.stringify(q, null, 2));
}

main().catch(err=>{ console.error('Smoke test failed:', err); process.exit(1); });
