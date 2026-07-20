import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerTool } from '../registry.js';

// A reusable knowledge base of past researched answers. save_research persists {question, answer,
// sources, ts} to data/research-kb.json; recall_research fuzzy-matches saved entries by keyword so
// Grace can reuse a known answer before doing a fresh web search.

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const KB_PATH = path.join(ROOT, 'data', 'research-kb.json');

interface KbEntry { id: number; question: string; answer: string; sources: string[]; ts: string; }

function load(): KbEntry[] {
  try {
    const d = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
    return Array.isArray(d.entries) ? d.entries : [];
  } catch { return []; }
}
function save(entries: KbEntry[]): void {
  fs.mkdirSync(path.dirname(KB_PATH), { recursive: true });
  fs.writeFileSync(KB_PATH, JSON.stringify({ entries }, null, 2), 'utf8');
}

// Sources may arrive as an array (from another tool) or a comma/newline string (from the model).
function normalizeSources(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
  const s = String(v ?? '').trim();
  if (!s) return [];
  return s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean).slice(0, 12);
}

registerTool({
  name: 'save_research',
  description: 'Save a researched question and its answer to the reusable knowledge base (data/research-kb.json) so it can be recalled later without re-searching. Use after answering a factual question worth remembering.',
  params: {
    question: { type: 'string', description: 'the question that was researched', required: true },
    answer: { type: 'string', description: 'the answer / synthesis to remember', required: true },
    sources: { type: 'string', description: 'optional source URLs or titles, comma- or newline-separated' },
  },
  async run(args) {
    const question = String(args.question ?? '').trim();
    const answer = String(args.answer ?? '').trim();
    if (!question || !answer) return { error: 'both question and answer are required' };
    const entries = load();
    const id = entries.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    entries.push({ id, question, answer, sources: normalizeSources(args.sources), ts: new Date().toISOString() });
    try { save(entries); } catch (e) { return { error: String(e) }; }
    return { ok: true, id, saved: question, total: entries.length };
  },
});

registerTool({
  name: 'recall_research',
  description: 'Search the saved research knowledge base (data/research-kb.json) for a past answer by keyword BEFORE doing a fresh web search. Returns the best-matching saved Q&A with its sources.',
  params: {
    query: { type: 'string', description: 'keywords to search saved research for', required: true },
    limit: { type: 'number', description: 'how many matches to return (default 3, max 10)' },
  },
  async run(args) {
    const query = String(args.query ?? '').trim();
    if (!query) return { error: 'query is required' };
    const limit = Math.max(1, Math.min(10, Number(args.limit) || 3));
    const entries = load();
    if (!entries.length) return { query, count: 0, matches: [], note: 'Knowledge base is empty — nothing saved yet.' };

    // Unicode-aware split so Danish letters (æ ø å é) aren't treated as word delimiters — \W is
    // ASCII-only and would shred "læser" into ["l","ser"], wrecking recall in Grace's main language.
    const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
    if (!terms.length) return { query, count: 0, matches: [], note: 'Query had no usable keywords.' };

    const scored = entries.map((e) => {
      const body = `${e.question} ${e.answer}`.toLowerCase();
      const qOnly = e.question.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (body.includes(t)) score += 1;
        if (qOnly.includes(t)) score += 0.5; // question hits count double-ish
      }
      return { e, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);

    if (!scored.length) return { query, count: 0, matches: [], note: 'No saved research matched — do a fresh research call.' };
    return {
      query,
      count: scored.length,
      matches: scored.map(({ e, score }) => ({
        id: e.id, question: e.question, answer: e.answer, sources: e.sources, ts: e.ts, score: Math.round(score * 10) / 10,
      })),
    };
  },
});
