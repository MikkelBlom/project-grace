import os from 'os';
import { registerTool } from '../registry.js';

const OLLAMA_URL = process.env.GRACE_OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.GRACE_LLM_MODEL ?? 'gemma4:26b';

// meeting_prep — get Mikkel ready for a meeting/topic. Pulls his own local notes on the topic AND a
// quick live-web research pass, then LLM-produces a short prep brief: key points, questions to ask,
// and recent facts. Grounded in what was gathered (local notes + fresh sources).

async function buildBrief(topic: string, localContext: string, research: string): Promise<string | null> {
  const prompt = `Help Mikkel prepare for a meeting / discussion about: "${topic}".\n\n`
    + `YOUR LOCAL NOTES (from his files — may be empty):\n${localContext || '(none found)'}\n\n`
    + `RECENT WEB RESEARCH (may be empty):\n${research || '(none)'}\n\n`
    + `Using ONLY the material above (do not invent facts), write a concise prep brief with three short sections:\n`
    + `1. Key points to know\n2. Questions to ask\n3. Recent facts / things to watch\n`
    + `Keep it tight and spoken-style. If a section has nothing to draw on, say so briefly rather than padding.`;
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
  name: 'meeting_prep',
  description: "Prepare Mikkel for a meeting or discussion on a topic: gather his local notes on it plus a quick web-research pass, then produce a short prep brief (key points, questions to ask, recent facts). Use when he says \"prep me for...\", \"I have a meeting about...\", or \"help me get ready for...\".",
  params: { topic: { type: 'string', description: 'the meeting topic or title', required: true } },
  async run(args, ctx) {
    if (!ctx) return { error: 'meeting_prep needs tool context (call it as a normal tool)' };
    const topic = String(args.topic ?? '').trim();
    if (!topic) return { error: 'topic is required' };

    const sources: string[] = [];

    // 1) Local notes / files on the topic (best-effort) and 2) a quick research pass — in parallel.
    const [scRes, reRes] = await Promise.all([
      ctx.callTool('search_content', { query: topic, root: os.homedir(), maxResults: 20 }).catch((e) => ({ error: String(e) })),
      ctx.callTool('research', { question: topic }).catch((e) => ({ error: String(e) })),
    ]);

    const sc = scRes as any;
    const localLines: string[] = [];
    for (const m of (sc?.matches ?? [])) {
      const text = String(m.text ?? '').trim();
      if (!text) continue;
      localLines.push(`- ${text}`);
      const file = String(m.file ?? '');
      if (file && !sources.includes(file)) sources.push(file);
    }
    const localContext = localLines.slice(0, 25).join('\n').slice(0, 6000);

    const re = reRes as any;
    let research = '';
    if (re?.synthesis?.answer) research = String(re.synthesis.answer);
    for (const s of (re?.sources ?? [])) {
      const line = `[${s.n}] ${s.title}: ${String(s.excerpt || s.snippet || '').slice(0, 300)}`;
      research += `\n${line}`;
      if (s.url && !sources.includes(s.url)) sources.push(s.url);
    }
    research = research.trim().slice(0, 6000);

    const brief = await buildBrief(topic, localContext, research);
    return {
      topic,
      sources,
      brief: brief ?? undefined,
      note: brief
        ? 'Relay the prep brief to Mikkel. It is grounded in his notes and fresh sources — flag anything from the web as not fully verified if the research was thin.'
        : 'Could not reach the summarizer. Share the gathered material below with Mikkel without adding outside facts.',
      gathered: brief ? undefined : { localContext, research },
    };
  },
});
