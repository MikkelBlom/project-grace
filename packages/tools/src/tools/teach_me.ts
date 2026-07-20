import { registerTool } from '../registry.js';

const OLLAMA_URL = process.env.GRACE_OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.GRACE_LLM_MODEL ?? 'gemma4:26b';

// teach_me — turn any topic into a short spoken-style micro-lesson plus a 3-question quiz.
// Optionally grounds the lesson in live web sources (via the research tool) so it is not
// limited to the model's frozen memory.

interface QuizItem { q: string; a: string; }

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

function normalizeQuiz(value: unknown): QuizItem[] {
  if (!Array.isArray(value)) return [];
  const out: QuizItem[] = [];
  for (const item of value) {
    if (item && typeof item === 'object') {
      const q = String((item as any).q ?? (item as any).question ?? '').trim();
      const a = String((item as any).a ?? (item as any).answer ?? '').trim();
      if (q) out.push({ q, a });
    }
  }
  return out;
}

registerTool({
  name: 'teach_me',
  description: 'Teach Mikkel about a topic: produce a short, spoken-style lesson (a few sentences) plus 3 quiz questions with answers. Use when he asks you to teach, explain, or quiz him on something. Set research=true to ground the lesson in live web sources first.',
  params: {
    topic: { type: 'string', description: 'the subject to teach, in natural language', required: true },
    research: { type: 'boolean', description: 'if true, look the topic up on the web first and ground the lesson in those sources (default false)' },
  },
  async run(args, ctx) {
    const topic = String(args.topic ?? '').trim();
    if (!topic) return { error: 'topic is required' };
    const doResearch = args.research === true || args.research === 'true';

    // Optional grounding pass — pull live sources so the lesson is factual, not just recalled.
    let grounding = '';
    let grounded = false;
    if (doResearch) {
      if (!ctx) {
        // No context to call research — continue ungrounded rather than failing outright.
      } else {
        try {
          const r = (await ctx.callTool('research', { question: topic })) as any;
          const parts: string[] = [];
          if (r?.synthesis?.answer) parts.push(String(r.synthesis.answer));
          for (const s of (r?.sources ?? []).slice(0, 3)) {
            const excerpt = String(s?.excerpt ?? s?.snippet ?? '').trim();
            if (excerpt) parts.push(`[${s.n}] ${s.title}: ${excerpt.slice(0, 800)}`);
          }
          grounding = parts.join('\n\n').trim();
          grounded = grounding.length > 0;
        } catch { /* ungrounded fallback */ }
      }
    }

    const groundingBlock = grounded
      ? `Base the lesson ONLY on these researched SOURCES. Do not invent facts beyond them.\n\nSOURCES:\n${grounding}\n\n`
      : '';

    const prompt =
      `You are Grace, teaching Mikkel about "${topic}".\n${groundingBlock}` +
      `Write a short, warm, spoken-style lesson of 3-5 sentences that he could listen to out loud. ` +
      `Then write exactly 3 quiz questions that test the lesson, each with a short correct answer.\n\n` +
      `Return ONLY JSON in this exact shape:\n` +
      `{\n  "lesson": "the spoken-style lesson",\n  "quiz": [\n    {"q": "question 1", "a": "answer 1"},\n    {"q": "question 2", "a": "answer 2"},\n    {"q": "question 3", "a": "answer 3"}\n  ]\n}`;

    try {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          prompt,
          stream: false, think: false, format: 'json',
          options: { temperature: 0.3 }, keep_alive: -1,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return { error: `Ollama HTTP ${res.status}` };
      const d = (await res.json()) as { response?: string };
      const parsed = extractJson(d.response ?? '');
      if (!parsed) return { error: 'could not parse lesson from model', raw: (d.response ?? '').slice(0, 200) };
      const lesson = String(parsed.lesson ?? '').trim();
      const quiz = normalizeQuiz(parsed.quiz).slice(0, 3);
      if (!lesson) return { error: 'model returned an empty lesson' };
      return { topic, grounded, lesson, quiz };
    } catch (e) { return { error: String(e) }; }
  },
});
