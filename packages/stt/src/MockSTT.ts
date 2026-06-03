// ─────────────────────────────────────────────
// MockSTT — simulates Faster-Whisper for Phase 0
// Replace with WhisperSTT.ts in Phase 1
// ─────────────────────────────────────────────

import { bus } from '@grace/core';

const TEST_INPUTS = [
  'Grace, hvad er status på systemet?',
  'Kan du hjælpe mig med at skrive en TypeScript funktion der sorterer et array af objekter?',
  'Hvad er det smarteste ved denne arkitektur?',
  'Grace, vis mig overlayets states',
  'Hvordan er hukommelsessystemet designet?',
  'Grace, skift til brainstorm mode',
];

export class MockSTT {
  private running = false;
  private handle: ReturnType<typeof setInterval> | null = null;
  private idx = 0;

  start(): void {
    if (this.running) return;
    this.running = true;

    bus.emit('stt:listening', { active: true });
    console.log('[MockSTT] Started — sender test-input hvert 9. sekund');
    console.log('[MockSTT] I Phase 1 erstattes dette med Faster-Whisper Large v3');

    // First input after 3 seconds (system startup grace period)
    setTimeout(() => {
      this.sendNext();
      // Then every 9 seconds
      this.handle = setInterval(() => this.sendNext(), 9000);
    }, 3000);
  }

  stop(): void {
    this.running = false;
    if (this.handle) clearInterval(this.handle);
    bus.emit('stt:listening', { active: false });
    console.log('[MockSTT] Stopped');
  }

  /** Simulate a specific user utterance (for testing) */
  inject(text: string): void {
    const sessionId = `injected-${Date.now()}`;
    console.log(`[MockSTT] Injecting: "${text}"`);
    bus.emit('stt:heard', { text, confidence: 1.0, sessionId });
  }

  private sendNext(): void {
    if (!this.running) return;
    const text = TEST_INPUTS[this.idx % TEST_INPUTS.length]!;
    this.idx++;
    const sessionId = `mock-${Date.now()}`;
    console.log(`[MockSTT] Heard: "${text}"`);
    bus.emit('stt:vad', { hasVoice: true });
    bus.emit('stt:heard', { text, confidence: 0.97, sessionId });
  }
}
