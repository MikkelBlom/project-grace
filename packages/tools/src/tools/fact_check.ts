import { registerTool } from '../registry.js';

const OLLAMA_URL = process.env.GRACE_OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.GRACE_LLM_MODEL ?? 'gemma4:26b';

// Verify a specific claim against live sources — a focused "is it true that…?" verdict.
registerTool({
  name: 'fact_check',
  description: 'Check whether a specific factual CLAIM is true using live web sources. Returns a verdict (supported / contradicted / mixed / unverified) with cited evidence. Use when Mikkel asks "is it true that..." or wants something verified.',
  params: { claim: { type: 'string', description: 'the claim to check', required: true } },
  async run(args, ctx) {
    if (!ctx) return { error: 'fact_check needs tool context' };
    const claim = String(args.claim ?? '').trim();
    if (!claim) return { error: 'claim is required' };

    const s = (await ctx.callTool('web_search', { query: claim, limit: 6 })) as any;
    const results = (s?.results ?? []).slice(0, 4);
    if (!results.length) return { claim, verdict: 'unverified', note: s?.error || 'no sources found' };

    const pages = await Promise.all(results.slice(0, 3).map((r: any) =>
      ctx.callTool('fetch_url', { url: r.url, maxChars: 3000 }).catch(() => ({ error: 'x' })),
    ));
    const corpus = results.map((r: any, i: number) =>
      `[${i + 1}] ${r.title} (${r.url})\n${(pages[i] as any)?.text?.slice(0, 1500) || r.snippet}`).join('\n\n');

    try {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          prompt: `Assess this CLAIM STRICTLY against the SOURCES (no outside knowledge).\nCLAIM: ${claim}\n\nSOURCES:\n${corpus}\n\nReturn ONLY JSON: {"verdict":"supported|contradicted|mixed|unverified","evidence":"one or two sentences citing source numbers"}`,
          stream: false, think: false, format: 'json', options: { temperature: 0.1 }, keep_alive: -1,
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) return { claim, verdict: 'unverified', error: `Ollama HTTP ${res.status}` };
      const d = (await res.json()) as { response?: string };
      const raw = (d.response ?? '').trim();
      const a = raw.indexOf('{'); const b = raw.lastIndexOf('}');
      const parsed = a >= 0 && b >= 0 ? JSON.parse(raw.slice(a, b + 1)) : {};
      return {
        claim,
        verdict: parsed.verdict || 'unverified',
        evidence: parsed.evidence || '',
        sources: results.map((r: any) => ({ title: r.title, url: r.url })),
      };
    } catch (e) { return { claim, verdict: 'unverified', error: String(e).slice(0, 120) }; }
  },
});
