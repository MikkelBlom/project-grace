// ─────────────────────────────────────────────────────────────────────────────
// Google Calendar tools (primary calendar) — REST v3, no google library.
//   calendar_agenda        — list upcoming events (default today + tomorrow)
//   calendar_create_event  — create an event; previews unless confirm:true
//
// Auth comes from lib/google.ts (refresh-token flow). Every path degrades to a
// structured { error, setup } when Grace isn't signed in yet.
// ─────────────────────────────────────────────────────────────────────────────

import { registerTool } from '../registry.js';
import { googleFetch, googleErrorResult } from '../lib/google.js';

const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

interface GCalEvent {
  summary?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

const whenOf = (t?: { dateTime?: string; date?: string }): string => t?.dateTime ?? t?.date ?? '';

// ── calendar_agenda ──────────────────────────────────────────────────────────
registerTool({
  name: 'calendar_agenda',
  description:
    "List upcoming events from Mikkel's primary Google Calendar. Default window is today + tomorrow; pass days to widen it. Use when he asks what's on his calendar / schedule / agenda / what's coming up.",
  params: {
    days: { type: 'number', description: 'how many days ahead to include (default 2 = today + tomorrow)' },
  },
  async run(args) {
    const days = Math.max(1, Math.min(30, Math.round(Number(args.days) || 2)));
    const now = new Date();
    const timeMin = now.toISOString();
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    end.setDate(end.getDate() + (days - 1));
    const timeMax = end.toISOString();

    const url =
      `${API}?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
      `&singleEvents=true&orderBy=startTime&maxResults=20`;

    try {
      const res = await googleFetch(url);
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 200);
        return { error: `Calendar API HTTP ${res.status}. ${body}` };
      }
      const data = (await res.json()) as { items?: GCalEvent[] };
      const events = (data.items ?? []).map((e) => ({
        summary: (e.summary ?? '(no title)').trim(),
        start: whenOf(e.start),
        end: whenOf(e.end),
        location: e.location?.trim() || undefined,
      }));
      return {
        range: { from: timeMin, to: timeMax, days },
        count: events.length,
        events,
        note: events.length ? undefined : 'No events in that window.',
      };
    } catch (e) {
      return googleErrorResult(e);
    }
  },
});

// ── calendar_create_event ────────────────────────────────────────────────────
registerTool({
  name: 'calendar_create_event',
  description:
    "Create an event on Mikkel's primary Google Calendar. Give summary and start (ISO 8601), plus either end (ISO) or durationMin. By default this only PREVIEWS the event — call again with confirm:true to actually create it. Returns a link to the created event.",
  params: {
    summary: { type: 'string', description: 'event title', required: true },
    start: { type: 'string', description: 'start time, ISO 8601 (e.g. 2026-07-21T14:00:00+02:00)', required: true },
    end: { type: 'string', description: 'end time, ISO 8601 (optional if durationMin is given)' },
    durationMin: { type: 'number', description: 'length in minutes if end is not given (default 60)' },
    location: { type: 'string', description: 'location (optional)' },
    description: { type: 'string', description: 'notes / description (optional)' },
    confirm: { type: 'boolean', description: 'set true to actually create it; false (default) only previews' },
  },
  async run(args) {
    const summary = String(args.summary ?? '').trim();
    const startStr = String(args.start ?? '').trim();
    if (!summary || !startStr) return { error: 'summary and start are required' };

    const start = new Date(startStr);
    if (Number.isNaN(start.getTime())) return { error: `could not parse start time: "${startStr}"` };

    let endStr = String(args.end ?? '').trim();
    if (!endStr) {
      const durationMin = Math.max(1, Math.round(Number(args.durationMin) || 60));
      endStr = new Date(start.getTime() + durationMin * 60_000).toISOString();
    }
    const endDate = new Date(endStr);
    if (Number.isNaN(endDate.getTime())) return { error: `could not parse end time: "${endStr}"` };
    if (endDate.getTime() <= start.getTime()) return { error: 'end time must be after start time' };

    const location = String(args.location ?? '').trim() || undefined;
    const description = String(args.description ?? '').trim() || undefined;

    const event = {
      summary,
      location,
      description,
      start: { dateTime: start.toISOString(), timeZone: LOCAL_TZ },
      end: { dateTime: endDate.toISOString(), timeZone: LOCAL_TZ },
    };

    // Preview-only unless explicitly confirmed.
    if (args.confirm !== true) {
      return {
        preview: true,
        note: 'Not created yet — this is a preview. Call calendar_create_event again with confirm:true to add it.',
        event: {
          summary,
          start: event.start.dateTime,
          end: event.end.dateTime,
          location,
          description,
        },
      };
    }

    try {
      const res = await googleFetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 200);
        return { error: `Calendar API HTTP ${res.status}. ${body}` };
      }
      const created = (await res.json()) as GCalEvent & { id?: string };
      return {
        ok: true,
        created: true,
        id: created.id,
        summary: created.summary ?? summary,
        start: whenOf(created.start),
        end: whenOf(created.end),
        link: created.htmlLink,
      };
    } catch (e) {
      return googleErrorResult(e);
    }
  },
});
