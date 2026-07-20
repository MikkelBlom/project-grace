import { scheduler } from '@grace/core';
import { registerTool } from '../registry.js';

const OLLAMA_URL = process.env.GRACE_OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.GRACE_LLM_MODEL ?? 'gemma4:26b';

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  søndag: 0, mandag: 1, tirsdag: 2, onsdag: 3, torsdag: 4, fredag: 5, lørdag: 6,
};

// Fast dep-free parse of common natural-language times (EN + DA). Returns ms epoch or null.
function parseWhen(input: string, now = Date.now()): number | null {
  const s = input.toLowerCase().trim();
  let m = s.match(/\b(?:in|om)\s+(\d+)\s*(sekund|sek|sec|second|seconds|min|minut|minute|minutes|minutter|hour|hours|time|timer|t|h)\b/);
  if (m) {
    const n = Number(m[1]); const u = m[2]!;
    const mult = /^(h|hour|time|timer|t)$/.test(u) ? 3600e3 : /^(sek|sec|second|seconds|sekund)/.test(u) ? 1000 : 60e3;
    return now + n * mult;
  }
  const tomorrow = /\b(tomorrow|i morgen)\b/.test(s);
  m = s.match(/\b(?:at|kl\.?|klokken)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/);
  if (m) {
    let hh = Number(m[1]); const mm = m[2] ? Number(m[2]) : 0; const ap = m[3];
    if (ap === 'pm' && hh < 12) hh += 12; if (ap === 'am' && hh === 12) hh = 0;
    const d = new Date(now); d.setHours(hh, mm, 0, 0);
    if (tomorrow) d.setDate(d.getDate() + 1);
    else if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const wd = s.match(/\b(?:next |på |on )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|søndag|mandag|tirsdag|onsdag|torsdag|fredag|lørdag)\b/);
  if (wd) {
    const target = WEEKDAYS[wd[1]!]!; const d = new Date(now);
    let add = (target - d.getDay() + 7) % 7; if (add === 0) add = 7;
    d.setDate(d.getDate() + add); d.setHours(9, 0, 0, 0);
    return d.getTime();
  }
  if (tomorrow) { const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); }
  const p = Date.parse(input); if (!Number.isNaN(p)) return p;
  return null;
}

async function llmParseTime(input: string): Promise<number | null> {
  try {
    const nowIso = new Date().toISOString();
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: `Current time is ${nowIso}. Convert this reminder time to a single ISO 8601 datetime in the future. Reply ONLY with the ISO string, nothing else.\nTIME: ${input}`, stream: false, think: false, options: { temperature: 0 }, keep_alive: -1 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { response?: string };
    const iso = (d.response ?? '').trim().match(/\d{4}-\d{2}-\d{2}[T\s][\d:]+/)?.[0];
    const t = iso ? Date.parse(iso.replace(' ', 'T')) : NaN;
    return Number.isNaN(t) ? null : t;
  } catch { return null; }
}

registerTool({
  name: 'add_reminder',
  description: 'Set a timed reminder in natural language — "in 20 minutes", "tomorrow at 9", "next tuesday at 2pm", "om en time", "på fredag". Grace speaks + shows it when due (survives restarts). Use when Mikkel says "remind me to/at/in...".',
  params: {
    text: { type: 'string', description: 'what to remind him about', required: true },
    when: { type: 'string', description: 'the time in natural language', required: true },
  },
  async run(args) {
    const text = String(args.text ?? '').trim();
    const when = String(args.when ?? '').trim();
    if (!text || !when) return { error: 'text and when are required' };
    let dueAt = parseWhen(when);
    if (dueAt == null) dueAt = await llmParseTime(when);
    if (dueAt == null) return { error: `Could not understand the time "${when}". Try "in 20 minutes" or "tomorrow at 9".` };
    if (dueAt <= Date.now()) return { error: 'that time is in the past' };
    const r = scheduler.add(text, dueAt);
    return { ok: true, id: r.id, text, dueAt: new Date(dueAt).toISOString(), inMinutes: Math.round((dueAt - Date.now()) / 60000) };
  },
});

registerTool({
  name: 'list_reminders',
  description: 'List Mikkel\'s upcoming reminders.',
  params: {},
  async run() {
    return { reminders: scheduler.list().map((r) => ({ id: r.id, text: r.text, due: new Date(r.dueAt).toISOString(), recurring: !!r.recurEveryMs })) };
  },
});

registerTool({
  name: 'cancel_reminder',
  description: 'Cancel a reminder by its id (from list_reminders).',
  params: { id: { type: 'string', description: 'the reminder id', required: true } },
  async run(args) { return { ok: true, cancelled: scheduler.cancel(String(args.id ?? '')) }; },
});
