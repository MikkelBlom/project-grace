import { registerTool } from '../registry.js';

const OLLAMA_URL = process.env.GRACE_OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.GRACE_LLM_MODEL ?? 'gemma4:26b';

// extract_preferences — mine the recent conversation for DURABLE facts about Mikkel
// (workflows, style, routines, recurring context) and PROPOSE them for the profile.
// This never writes anything; it only suggests. Applying is a separate, explicit step
// through update_user_profile so Mikkel stays in control of what gets persisted.

function extractJson(raw: string): any {
  const s = (raw ?? '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}

interface Proposal { fact: string; category: string; }

function normalizeProposals(value: unknown): Proposal[] {
  if (!Array.isArray(value)) return [];
  const out: Proposal[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    let fact = '';
    let category = 'general';
    if (typeof item === 'string') {
      fact = item.trim();
    } else if (item && typeof item === 'object') {
      fact = String((item as any).fact ?? (item as any).text ?? '').trim();
      const c = String((item as any).category ?? '').trim();
      if (c) category = c;
    }
    if (!fact) continue;
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ fact, category });
  }
  return out;
}

registerTool({
  name: 'extract_preferences',
  description: "Review the recent conversation and PROPOSE durable preference facts about Mikkel (workflows, style, routines, recurring context) to remember. Returns proposals only — it never writes them. Use before update_user_profile when you want to capture what you have just learned about how he likes to work.",
  params: {
    turns: { type: 'number', description: 'how many recent turns to review (default 40)' },
  },
  async run(args, ctx) {
    if (!ctx) return { error: 'extract_preferences needs tool context (to read memory)' };
    const turns = Math.max(4, Math.min(100, Number(args.turns) || 40));

    const mem = (await ctx.callTool('browse_memory', { turns })) as any;
    const rows = Array.isArray(mem?.turns) ? mem.turns : [];
    if (!rows.length) return { proposals: [], note: 'No recent conversation to analyze yet.' };

    const transcript = rows
      .map((t: any) => `${t.role === 'grace' ? 'Grace' : 'Mikkel'}: ${String(t.content ?? '')}`)
      .join('\n');
    const existing = Array.isArray(mem?.profileFacts) ? mem.profileFacts.slice(0, 20) : [];
    const existingBlock = existing.length
      ? `Facts ALREADY in the profile (do NOT repeat these):\n${existing.map((f: string) => `- ${f}`).join('\n')}\n\n`
      : '';

    const prompt =
      `From the CONVERSATION below, extract only DURABLE preference facts about Mikkel — how he likes ` +
      `to work, his style, tools, routines, and recurring context. Ignore one-off requests, transient task ` +
      `details, and anything you are not confident is a lasting preference.\n\n${existingBlock}` +
      `CONVERSATION:\n${transcript}\n\n` +
      `Return ONLY JSON:\n{\n  "preferences": [\n    {"fact": "a concise durable fact about Mikkel", "category": "workflow | style | routine | tools | general"}\n  ]\n}\n` +
      `Return an empty array if nothing durable is worth remembering.`;

    try {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          prompt,
          stream: false, think: false, format: 'json',
          options: { temperature: 0.2 }, keep_alive: -1,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return { error: `Ollama HTTP ${res.status}` };
      const d = (await res.json()) as { response?: string };
      const parsed = extractJson(d.response ?? '');
      const proposals = normalizeProposals(parsed?.preferences ?? parsed?.proposals ?? parsed);
      return {
        turnsReviewed: rows.length,
        proposals,
        note: proposals.length
          ? 'These are PROPOSALS only — nothing was saved. To persist any, call update_user_profile with the chosen facts (newline/semicolon/pipe separated) and their category. Confirm with Mikkel first.'
          : 'No durable new preferences found in the recent conversation.',
      };
    } catch (e) { return { error: String(e) }; }
  },
});
