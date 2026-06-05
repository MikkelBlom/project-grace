import { graceMemory } from '@grace/core';
import { registerTool } from '../registry.js';

registerTool({
  name: 'recall_memory',
  description: 'Search long-term semantic memory and scratchpads. Returns prioritized memory hits filtered by namespace, recency, and similarity.',
  params: {
    query: { type: 'string', description: 'Search query (what you want to recall)', required: true },
    namespace: { type: 'string', description: 'optional namespace or comma-separated list: conversation,profile,task,mission,scratchpad,personality' },
    limit: { type: 'number', description: 'maximum number of hits to return' },
    minScore: { type: 'number', description: 'minimum combined relevance score (0-1) to include' },
    recencyWeight: { type: 'number', description: 'weight given to recency vs semantic similarity (0-1)' },
  },
  async run(args) {
    const q = typeof args.query === 'string' ? args.query.trim() : '';
    if (!q) return { error: 'missing query' };
    const namespaceArg = typeof args.namespace === 'string' ? args.namespace.split(/[,\s]+/).map(s => s.trim()).filter(Boolean) : undefined;
    const namespace = Array.isArray(namespaceArg) && namespaceArg.length === 1 ? namespaceArg[0] : (Array.isArray(namespaceArg) ? namespaceArg as any : undefined);
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(40, Math.floor(args.limit))) : undefined;
    const minScore = typeof args.minScore === 'number' ? Math.max(0, Math.min(1, args.minScore)) : undefined;
    const recencyWeight = typeof args.recencyWeight === 'number' ? Math.max(0, Math.min(1, args.recencyWeight)) : undefined;

    const hits = await graceMemory.search(q, { limit, namespace: namespace ?? 'all', minScore, recencyWeight });
    return { ok: true, query: q, count: hits.length, hits };
  },
});
