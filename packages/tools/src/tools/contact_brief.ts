import os from 'os';
import { registerTool } from '../registry.js';

const OLLAMA_URL = process.env.GRACE_OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.GRACE_LLM_MODEL ?? 'gemma4:26b';

// contact_brief — "who is this person, and what's the recent context?" Grace gathers whatever she
// already knows locally (files that mention the name + her own long-term memory) and LLM-summarizes
// it into a short brief. Grounded only in what was gathered — no invented biography.

interface Snippet { source: string; text: string; }

async function summarize(name: string, snippets: Snippet[]): Promise<string | null> {
  if (!snippets.length) return null;
  const corpus = snippets.slice(0, 30)
    .map((s, i) => `[${i + 1}] (${s.source}) ${s.text.slice(0, 400)}`)
    .join('\n').slice(0, 8000);
  const prompt = `You are briefing Mikkel about a person named "${name}", using ONLY the CONTEXT below `
    + `(gathered from his files and Grace's memory). Do not invent facts. If the context is thin, say so.\n\n`
    + `CONTEXT:\n${corpus}\n\n`
    + `Write a short spoken-style brief (3-5 sentences): who this person appears to be to Mikkel, `
    + `and the most recent / relevant context. Mark anything uncertain as such.`;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt, stream: false, think: false, options: { temperature: 0.2, num_ctx: 8192 }, keep_alive: -1 }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { response?: string };
    return String(data.response ?? '').trim() || null;
  } catch { return null; }
}

registerTool({
  name: 'contact_brief',
  description: "Brief Mikkel on a person: gather everything Grace knows about them from his files and her long-term memory, then summarize who they are and the recent context. Use when he asks \"who is X\", \"remind me about X\", or \"what do we know about X\" for a person.",
  params: { name: { type: 'string', description: "the person's name", required: true } },
  async run(args, ctx) {
    if (!ctx) return { error: 'contact_brief needs tool context (call it as a normal tool)' };
    const name = String(args.name ?? '').trim();
    if (!name) return { error: 'name is required' };

    const snippets: Snippet[] = [];
    const sources: string[] = [];

    // 1) Local files that mention the name (best-effort).
    try {
      const sc = (await ctx.callTool('search_content', { query: name, root: os.homedir(), maxResults: 25 })) as any;
      for (const m of (sc?.matches ?? [])) {
        const file = String(m.file ?? '');
        const text = String(m.text ?? '').trim();
        if (!text) continue;
        snippets.push({ source: file || 'file', text });
        if (file && !sources.includes(file)) sources.push(file);
      }
    } catch { /* best-effort */ }

    // 2) Grace's own long-term / semantic memory (best-effort).
    try {
      const rm = (await ctx.callTool('recall_memory', { query: name })) as any;
      for (const h of (rm?.hits ?? [])) {
        const text = String(h?.text ?? h?.content ?? h?.value ?? (typeof h === 'string' ? h : JSON.stringify(h))).trim();
        if (!text) continue;
        snippets.push({ source: 'memory', text });
        if (!sources.includes('memory')) sources.push('memory');
      }
    } catch { /* best-effort */ }

    if (!snippets.length) {
      return {
        name, sources,
        brief: `I don't have anything on file about ${name} — no mentions in your files and nothing in my memory. If you tell me about them, I'll remember for next time.`,
      };
    }

    const brief = await summarize(name, snippets);
    return {
      name,
      sources,
      brief: brief ?? undefined,
      note: brief
        ? 'Relay the brief to Mikkel. It is grounded only in his files and my memory — do not add outside facts.'
        : 'Could not reach the summarizer. Below are the raw snippets I gathered; summarize them for Mikkel without adding outside facts.',
      snippets: brief ? undefined : snippets.slice(0, 12),
    };
  },
});
