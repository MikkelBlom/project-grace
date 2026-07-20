import { registerTool } from '../registry.js';

const OLLAMA_URL = process.env.GRACE_OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.GRACE_LLM_MODEL ?? 'gemma4:26b';

// episodic_recall — "what happened around <time>?" Resolves a natural time reference
// (English or Danish) to an approximate day/window, pulls recent turns + semantic memory,
// filters by that window, and summarizes. Best-effort: if the time can't be resolved it
// still returns whatever semantic recall found.

const DAY = 86_400_000;

interface Window { startMs: number; endMs: number; label: string; }

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Map a natural time phrase to an approximate [start, end) window relative to `now`.
function resolveWhen(phraseRaw: string, now: number): Window | null {
  const p = phraseRaw.toLowerCase().trim();
  const today0 = startOfDay(now);

  if (/\b(today|i dag|idag)\b/.test(p)) return { startMs: today0, endMs: today0 + DAY, label: 'today' };
  if (/\b(day before yesterday|i forgårs|forgaars|forgårs)\b/.test(p))
    return { startMs: today0 - 2 * DAY, endMs: today0 - DAY, label: 'the day before yesterday' };
  if (/\b(yesterday|i går|igår|i gaar)\b/.test(p)) return { startMs: today0 - DAY, endMs: today0, label: 'yesterday' };
  if (/\b(last week|sidste uge|forrige uge)\b/.test(p)) return { startMs: today0 - 14 * DAY, endMs: today0 - 7 * DAY, label: 'last week' };

  if (/\b(this week|denne uge|i denne uge)\b/.test(p)) {
    const dow = new Date(today0).getDay(); // 0=Sun
    const sinceMonday = (dow + 6) % 7; // days since most recent Monday
    const monday = today0 - sinceMonday * DAY;
    return { startMs: monday, endMs: today0 + DAY, label: 'this week' };
  }

  const daysAgo = p.match(/(\d+)\s*(?:day|days|dag|dage)\s*(?:ago|siden)?/);
  if (daysAgo) {
    const n = Math.max(1, Math.min(365, Number(daysAgo[1])));
    return { startMs: today0 - n * DAY, endMs: today0 - (n - 1) * DAY, label: `${n} day(s) ago` };
  }

  if (/\b(last month|sidste måned|forrige måned|sidste maaned)\b/.test(p))
    return { startMs: today0 - 30 * DAY, endMs: today0, label: 'the last month' };

  // Weekday names, English + Danish. Danish "i mandags" / "mandags" also matched.
  const weekdays: Array<[string, number]> = [
    ['sunday', 0], ['søndag', 0], ['soendag', 0],
    ['monday', 1], ['mandag', 1],
    ['tuesday', 2], ['tirsdag', 2],
    ['wednesday', 3], ['onsdag', 3],
    ['thursday', 4], ['torsdag', 4],
    ['friday', 5], ['fredag', 5],
    ['saturday', 6], ['lørdag', 6], ['loerdag', 6],
  ];
  for (const [name, dow] of weekdays) {
    const re = new RegExp(`\\b(?:i\\s+)?${name}s?\\b`);
    if (re.test(p)) {
      const nowDow = new Date(today0).getDay();
      let diff = (nowDow - dow + 7) % 7;
      if (diff === 0) diff = 7; // "monday" means the most recent past Monday, not today
      const dayStart = today0 - diff * DAY;
      return { startMs: dayStart, endMs: dayStart + DAY, label: name };
    }
  }

  return null;
}

// browse_memory renders `when` as "YYYY-MM-DD HH:MM" (UTC). Parse back to ms for windowing.
function turnMs(when: unknown): number | null {
  if (typeof when !== 'string' || !when) return null;
  const t = Date.parse(when.replace(' ', 'T') + ':00Z');
  return Number.isNaN(t) ? null : t;
}

registerTool({
  name: 'episodic_recall',
  description: 'Recall what happened around a natural time reference (e.g. "yesterday", "last week", "i mandags"). Resolves the time, pulls recent conversation and long-term memory, filters to that period, and summarizes. Use when Mikkel asks what you talked about or did at some past time.',
  params: {
    when: { type: 'string', description: 'a natural time reference, e.g. "yesterday", "last Tuesday", "i mandags", "3 days ago"', required: true },
  },
  async run(args, ctx) {
    if (!ctx) return { error: 'episodic_recall needs tool context (to read memory)' };
    const when = String(args.when ?? '').trim();
    if (!when) return { error: 'when is required' };

    const now = Date.now();
    const win = resolveWhen(when, now);

    // 1) Recent turns, filtered by the resolved window (if any).
    const mem = (await ctx.callTool('browse_memory', { turns: 100 }).catch(() => null)) as any;
    const allTurns = Array.isArray(mem?.turns) ? mem.turns : [];
    let inWindow: any[] = [];
    if (win) {
      const w = win; // non-null capture so narrowing holds inside the closure
      inWindow = allTurns.filter((t: any) => {
        const ms = turnMs(t.when);
        return ms != null && ms >= w.startMs && ms < w.endMs;
      });
    }

    // 2) Semantic long-term memory — best-effort, catches things outside the recent-turn buffer.
    const semantic = (await ctx.callTool('recall_memory', {
      query: `what happened ${when}`,
      limit: 8,
    }).catch(() => null)) as any;
    const semanticHits = Array.isArray(semantic?.hits) ? semantic.hits : [];

    const hits = inWindow.map((t: any) => ({ role: t.role, content: t.content, when: t.when }));

    if (!hits.length && !semanticHits.length) {
      return {
        when,
        resolved: win?.label ?? 'could not resolve the time reference',
        summary: `I couldn't find anything I have on record from ${win?.label ?? 'that time'}.`,
        hits: [],
      };
    }

    // 3) Summarize what was going on around then.
    const turnBlock = hits.map((h: any) => `${h.role === 'grace' ? 'Grace' : 'Mikkel'} (${h.when}): ${h.content}`).join('\n');
    const semBlock = semanticHits
      .map((h: any, i: number) => `[${i + 1}] ${String(h?.text ?? h?.content ?? JSON.stringify(h)).slice(0, 240)}`)
      .join('\n');
    const prompt =
      `Mikkel asked what happened around "${when}"${win ? ` (approximately ${win.label})` : ''}. ` +
      `Using ONLY the material below, briefly summarize what was discussed or done then, in a warm spoken style. ` +
      `If the material is thin or off-topic, say so honestly rather than guessing.\n\n` +
      (turnBlock ? `RECENT TURNS FROM THAT PERIOD:\n${turnBlock}\n\n` : '') +
      (semBlock ? `RELATED LONG-TERM MEMORY:\n${semBlock}\n\n` : '') +
      `Summary:`;

    try {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          prompt,
          stream: false, think: false, options: { temperature: 0.3 }, keep_alive: -1,
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) {
        return { when, resolved: win?.label ?? 'unresolved', summary: '', hits, semanticHitCount: semanticHits.length, error: `Ollama HTTP ${res.status}` };
      }
      const d = (await res.json()) as { response?: string };
      return {
        when,
        resolved: win?.label ?? 'could not resolve the time reference (searched semantic memory instead)',
        summary: (d.response ?? '').trim(),
        hits,
        semanticHitCount: semanticHits.length,
      };
    } catch (e) {
      return { when, resolved: win?.label ?? 'unresolved', summary: '', hits, semanticHitCount: semanticHits.length, error: String(e) };
    }
  },
});
