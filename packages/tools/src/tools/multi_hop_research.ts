import { registerTool } from '../registry.js';

// Deep, multi-step research. Runs the `research` tool once, then uses the local LLM to propose 1-2
// follow-up questions from the first pass's synthesis/sources, researches those too, and merges all
// sources. Total research passes ("hops") are capped at 3 so it stays bounded.

const OLLAMA_URL = process.env.GRACE_OLLAMA_URL ?? 'http://localhost:11434';
const LLM_MODEL = process.env.GRACE_LLM_MODEL ?? 'gemma4:26b';

interface ResearchResult {
  error?: string;
  sources?: Array<{ title?: string; url?: string; published?: string }>;
  synthesis?: { answer?: string; confidence?: string };
}

// Ask the LLM for the most useful follow-up questions that the first pass did NOT fully answer.
async function proposeFollowups(question: string, synthesis: string, titles: string[], want: number): Promise<string[]> {
  const context = [
    synthesis ? `Partial answer so far: ${synthesis}` : '',
    titles.length ? `Sources found:\n- ${titles.slice(0, 8).join('\n- ')}` : '',
  ].filter(Boolean).join('\n\n');
  const prompt = `You are planning a deeper research pass on the ORIGINAL question below.\n`
    + `ORIGINAL QUESTION: ${question}\n\n${context}\n\n`
    + `Propose up to ${want} NEW, specific follow-up question(s) that would fill the biggest remaining gaps `
    + `or verify a shaky claim. Each must be self-contained (usable as a standalone web search) and different `
    + `from the original. If the original is already fully answered, return an empty list.\n\n`
    + `Return ONLY JSON: {"followups": ["...", "..."]}`;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LLM_MODEL, prompt, stream: false, think: false, format: 'json', options: { temperature: 0.2, num_ctx: 8192 }, keep_alive: -1 }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { response?: string };
    const raw = (data.response ?? '').trim();
    const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
    if (start < 0 || end < 0) return [];
    const parsed = JSON.parse(raw.slice(start, end + 1));
    const arr = Array.isArray(parsed.followups) ? parsed.followups
      : Array.isArray(parsed.questions) ? parsed.questions : [];
    return arr.map((s: unknown) => String(s).trim()).filter(Boolean).slice(0, want);
  } catch { return []; }
}

registerTool({
  name: 'multi_hop_research',
  description: 'Deep multi-step research: researches a question, then uses the LLM to identify 1-2 follow-up questions, researches those too, and merges all sources. Use for broad or multi-part questions one search will not fully answer. Capped at 3 research passes.',
  params: {
    question: { type: 'string', description: 'the overall question to research deeply', required: true },
    max_hops: { type: 'number', description: 'total research passes including the first (default 3, max 3)' },
  },
  async run(args, ctx) {
    if (!ctx) return { error: 'multi_hop_research needs tool context (call it as a normal tool)' };
    const question = String(args.question ?? '').trim();
    if (!question) return { error: 'question is required' };
    const maxHops = Math.max(1, Math.min(3, Number(args.max_hops) || 3));

    const asked = new Set<string>([question.toLowerCase()]);
    const allSources: Array<{ title: string; url: string; published?: string; hop: string }> = [];
    const hops: Array<{ question: string; synthesis?: string; confidence?: string; sourceCount: number }> = [];

    const addSources = (srcs: ResearchResult['sources'], hopQ: string) => {
      for (const s of srcs ?? []) {
        const url = String(s?.url ?? '');
        if (!url || allSources.some((x) => x.url === url)) continue;
        allSources.push({ title: String(s?.title ?? ''), url, published: s?.published, hop: hopQ });
      }
    };

    // Hop 1 — the base research pass.
    const first = await ctx.callTool('research', { question }) as ResearchResult;
    if (first?.error && !first?.sources?.length) return { error: `research failed: ${first.error}`, question };
    addSources(first?.sources, question);
    hops.push({ question, synthesis: first?.synthesis?.answer, confidence: first?.synthesis?.confidence, sourceCount: (first?.sources ?? []).length });

    // Propose follow-ups and research them (respecting the remaining hop budget), in parallel.
    const budget = maxHops - 1;
    if (budget > 0) {
      const titles = allSources.slice(0, 8).map((s) => s.title).filter(Boolean);
      const followups = (await proposeFollowups(question, first?.synthesis?.answer ?? '', titles, budget))
        .filter((f) => f && !asked.has(f.toLowerCase()))
        .slice(0, budget);
      for (const f of followups) asked.add(f.toLowerCase());
      const results = await Promise.all(followups.map((f) =>
        (ctx!.callTool('research', { question: f }) as Promise<ResearchResult>).catch((e) => ({ error: String(e) } as ResearchResult)),
      ));
      followups.forEach((f, i) => {
        const r = results[i] ?? {};
        addSources(r.sources, f);
        hops.push({ question: f, synthesis: r.synthesis?.answer, confidence: r.synthesis?.confidence, sourceCount: (r.sources ?? []).length });
      });
    }

    const sources = allSources.slice(0, 12).map((s, i) => ({ n: i + 1, title: s.title, url: s.url, published: s.published, hop: s.hop }));
    return {
      question,
      hopCount: hops.length,
      hops,
      sourceCount: sources.length,
      sources,
      note: 'Multi-hop research complete. Write ONE combined answer for Mikkel from the per-hop syntheses and the merged sources above. Cite sources by title/url. Mark anything the sources do not clearly support as a best guess — do not invent facts.',
    };
  },
});
