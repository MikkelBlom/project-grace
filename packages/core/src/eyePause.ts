// Eye-strain guardian — the 20-20-20 rule (every ~20 min, look ~20 feet away for 20 seconds).
// A gentle recurring reminder (overlay + spoken), language-aware. Mode from the vision doc.
import { bus } from './EventBus.js';
import { settings } from './settings.js';

class EyePause {
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMin = 20;

  start(minutes = 20): { ok: boolean; intervalMin: number } {
    this.stop();
    this.intervalMin = Math.max(1, Math.min(120, Math.round(minutes) || 20));
    this.timer = setInterval(() => this.remind(), this.intervalMin * 60_000);
    bus.emit('overlay:notification', { text: `👁 Eye-pause on — reminder every ${this.intervalMin} min`, level: 'info', duration: 4000 });
    return { ok: true, intervalMin: this.intervalMin };
  }

  stop(): { ok: boolean } {
    if (this.timer) { clearInterval(this.timer); this.timer = null; return { ok: true }; }
    return { ok: false };
  }

  isOn(): boolean { return !!this.timer; }

  private remind(): void {
    const da = settings.language === 'da';
    bus.emit('tts:speaking', {
      text: da ? 'Kig væk fra skærmen i tyve sekunder — hvil øjnene lidt.' : 'Look away from the screen for twenty seconds — rest your eyes.',
      sessionId: `eye-${Date.now()}`,
    });
    bus.emit('overlay:notification', { text: '👁 20-20-20: look ~20 feet away for 20 seconds', level: 'info', duration: 20_000 });
  }
}

export const eyePause = new EyePause();
