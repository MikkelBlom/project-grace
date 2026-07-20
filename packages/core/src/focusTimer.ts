// ─────────────────────────────────────────────────────────────────────────────
// Deep Work / Focus timer — a Pomodoro-style focus session Grace runs for Mikkel.
//
// Start it by voice ("start a focus session", "deep work for 50 minutes"). Grace announces
// when the time is up and suggests a break. It's adaptive in the useful sense: Grace can
// extend it when Mikkel is in flow ("give me 10 more minutes") via extend_focus, rather than a
// brittle keystroke tracker. Language-aware (Danish/English) via the active language mode.
// ─────────────────────────────────────────────────────────────────────────────

import { bus } from './EventBus.js';
import { settings } from './settings.js';

class FocusTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private endsAt = 0;
  private task = '';
  private active = false;

  start(minutes: number, task = ''): { ok: boolean; endsInMin: number; task: string } {
    this.clearTimer();
    const min = Math.max(1, Math.min(180, Math.round(minutes) || 25));
    this.task = String(task ?? '').trim();
    this.endsAt = Date.now() + min * 60_000;
    this.active = true;
    this.timer = setTimeout(() => this.complete(), min * 60_000);
    bus.emit('overlay:notification', {
      text: this.task ? `🎯 Fokus: ${this.task} (${min} min)` : `🎯 Fokus i ${min} min`,
      level: 'info', duration: 4000,
    });
    bus.emit('overlay:timer', { active: true, endsAt: this.endsAt, task: this.task });
    return { ok: true, endsInMin: min, task: this.task };
  }

  extend(minutes: number): { ok: boolean; remainingMin: number } {
    if (!this.active) return { ok: false, remainingMin: 0 };
    const add = Math.max(1, Math.min(120, Math.round(minutes) || 10));
    this.endsAt += add * 60_000;
    this.clearTimer();          // clearTimer sets active=false…
    this.active = true;         // …so re-assert it, or status()/extend()/stop() think the session died.
    this.timer = setTimeout(() => this.complete(), Math.max(0, this.endsAt - Date.now()));
    bus.emit('overlay:timer', { active: true, endsAt: this.endsAt, task: this.task });
    return { ok: true, remainingMin: Math.max(0, Math.round((this.endsAt - Date.now()) / 60_000)) };
  }

  status(): { active: boolean; remainingMin: number; task: string } {
    return {
      active: this.active,
      remainingMin: this.active ? Math.max(0, Math.round((this.endsAt - Date.now()) / 60_000)) : 0,
      task: this.task,
    };
  }

  stop(): { ok: boolean } {
    const was = this.active;
    this.clearTimer();
    bus.emit('overlay:timer', { active: false, endsAt: 0, task: '' });
    return { ok: was };
  }

  private complete(): void {
    const da = settings.language === 'da';
    const msg = this.task
      ? (da ? `Så er der pause. Du fokuserede på ${this.task}. Rejs dig og stræk ud.` : `Time's up. You focused on ${this.task}. Stand up and stretch.`)
      : (da ? 'Så er der pause — godt arbejde. Rejs dig og stræk ud lidt.' : "Time's up — nice work. Stand up and stretch for a bit.");
    bus.emit('tts:speaking', { text: msg, sessionId: `focus-${Date.now()}` });
    bus.emit('overlay:notification', { text: '☕ Pause', level: 'info', duration: 8000 });
    bus.emit('overlay:timer', { active: false, endsAt: 0, task: '' });
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.active = false;
  }
}

export const focusTimer = new FocusTimer();
