// ─────────────────────────────────────────────────────────────────────────────
// Scheduler — fires timed reminders (natural-language) and recurring wellness nudges.
// A 30s ticker checks data/reminders.json; due reminders speak (bus) + show in the HUD. One-shots
// are dropped after firing; recurring ones reschedule. Survives restarts (persisted).
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { bus } from './EventBus.js';
import { settings } from './settings.js';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REM_PATH = path.join(ROOT, 'data', 'reminders.json');

export interface Reminder { id: string; text: string; dueAt: number; recurEveryMs?: number; tag?: string; }

/**
 * Next occurrence for a recurring reminder, advanced from the ORIGINAL dueAt (not the tick time) so
 * occurrences don't drift forward by up to one tick each, and stepped past `now` so a wake-from-sleep
 * that skipped several periods lands on the next future slot rather than replaying the backlog.
 */
export function nextRecurrence(dueAt: number, recurEveryMs: number, now: number): number {
  let next = dueAt + recurEveryMs;
  while (next <= now) next += recurEveryMs;
  return next;
}

class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  private load(): Reminder[] {
    try { const d = JSON.parse(fs.readFileSync(REM_PATH, 'utf8')); return Array.isArray(d.reminders) ? d.reminders : []; } catch { return []; }
  }
  private save(r: Reminder[]): void {
    try { fs.mkdirSync(path.dirname(REM_PATH), { recursive: true }); fs.writeFileSync(REM_PATH, JSON.stringify({ reminders: r }, null, 2)); } catch { /* best-effort */ }
  }

  add(text: string, dueAt: number, recurEveryMs?: number, tag?: string): Reminder {
    const r: Reminder = { id: `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, text, dueAt, recurEveryMs, tag };
    const all = this.load(); all.push(r); this.save(all);
    return r;
  }
  list(): Reminder[] { return this.load().sort((a, b) => a.dueAt - b.dueAt); }
  cancel(id: string): boolean { const all = this.load(); const next = all.filter((r) => r.id !== id && r.tag !== id); if (next.length === all.length) return false; this.save(next); return true; }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 30_000);
    this.tick();
  }

  private tick(): void {
    const now = Date.now();
    const all = this.load();
    const due: Reminder[] = [];
    const kept: Reminder[] = [];
    for (const r of all) {
      if (r.dueAt <= now) {
        due.push(r);
        if (r.recurEveryMs && r.recurEveryMs > 0) {
          kept.push({ ...r, dueAt: nextRecurrence(r.dueAt, r.recurEveryMs, now) });
        }
        // else: one-shot, drop
      } else kept.push(r);
    }
    if (due.length) { this.fire(due); this.save(kept); }
  }

  private fire(due: Reminder[]): void {
    const da = settings.language === 'da';
    // One HUD toast each (unique + cheap), but coalesce the VOICE into a single utterance so a burst
    // (several due in one tick, e.g. after wake-from-sleep) doesn't speak over itself.
    for (const r of due) bus.emit('overlay:notification', { text: `⏰ ${r.text}`, level: 'info', duration: 12_000 });
    const label = da ? 'Påmindelse' : 'Reminder';
    const text = due.length === 1
      ? `${label}: ${due[0]!.text}`
      : `${da ? 'Du har' : 'You have'} ${due.length} ${da ? 'påmindelser' : 'reminders'}: ${due.map((r) => r.text).join('; ')}`;
    bus.emit('tts:speaking', { text, sessionId: `rem-${Date.now().toString(36)}-${fireSeq++}` });
  }
}

let fireSeq = 0; // monotonic so batched reminders never share a sessionId within one tick

export const scheduler = new Scheduler();
