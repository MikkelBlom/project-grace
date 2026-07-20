import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerTool } from '../registry.js';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const KG_PATH = path.join(ROOT, 'data', 'knowledge-graph.json');

interface Triple { s: string; r: string; o: string; ts: number; }
function load(): Triple[] { try { const d = JSON.parse(fs.readFileSync(KG_PATH, 'utf8')); return Array.isArray(d.triples) ? d.triples : []; } catch { return []; } }
function save(t: Triple[]): void { try { fs.mkdirSync(path.dirname(KG_PATH), { recursive: true }); fs.writeFileSync(KG_PATH, JSON.stringify({ triples: t }, null, 2)); } catch { /* best-effort */ } }

registerTool({
  name: 'kg_relate',
  description: 'Remember a relationship between two things as a knowledge-graph triple: subject → relation → object (e.g. "Mikkel — works_on → Grace", "Grace — uses → gemma4"). Use to record durable facts connecting people, projects, and things.',
  params: {
    subject: { type: 'string', description: 'the subject entity', required: true },
    relation: { type: 'string', description: 'the relationship (e.g. works_on, uses, lives_in, knows)', required: true },
    object: { type: 'string', description: 'the object entity', required: true },
  },
  async run(args) {
    const s = String(args.subject ?? '').trim(), r = String(args.relation ?? '').trim(), o = String(args.object ?? '').trim();
    if (!s || !r || !o) return { error: 'subject, relation and object are required' };
    const all = load();
    if (!all.some((t) => t.s.toLowerCase() === s.toLowerCase() && t.r.toLowerCase() === r.toLowerCase() && t.o.toLowerCase() === o.toLowerCase())) {
      all.push({ s, r, o, ts: Date.now() });
      save(all);
    }
    return { ok: true, triple: `${s} —${r}→ ${o}`, total: all.length };
  },
});

registerTool({
  name: 'kg_query',
  description: "Query Grace's knowledge graph for everything she knows about an entity — all relationships where it appears as subject or object.",
  params: { entity: { type: 'string', description: 'the entity to look up', required: true } },
  async run(args) {
    const e = String(args.entity ?? '').trim().toLowerCase();
    if (!e) return { error: 'entity is required' };
    const hits = load().filter((t) => t.s.toLowerCase().includes(e) || t.o.toLowerCase().includes(e));
    return { entity: args.entity, count: hits.length, relations: hits.map((t) => `${t.s} —${t.r}→ ${t.o}`) };
  },
});
