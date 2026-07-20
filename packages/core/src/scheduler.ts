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
    let changed = false;
    const kept: Reminder[] = [];
    for (const r of all) {
      if (r.dueAt <= now) {
        this.fire(r);
        changed = true;
        if (r.recurEveryMs && r.recurEveryMs > 0) { kept.push({ ...r, dueAt: now + r.recurEveryMs }); }
        // else: one-shot, drop
      } else kept.push(r);
    }
    if (changed) this.save(kept);
  }

  private fire(r: Reminder): void {
    const da = settings.language === 'da';
    bus.emit('tts:speaking', { text: `${da ? 'Påmindelse' : 'Reminder'}: ${r.text}`, sessionId: `rem-${Date.now()}` });
    bus.emit('overlay:notification', { text: `⏰ ${r.text}`, level: 'info', duration: 12_000 });
  }
}

export const scheduler = new Scheduler();
