// ─────────────────────────────────────────────
// MockTTS — simulates Kokoro TTS for Phase 0
// Logs output to console, simulates speaking duration
// Replace with KokoroTTS.ts in Phase 1
// ─────────────────────────────────────────────

import { bus } from '@grace/core';

export class MockTTS {
  constructor() {
    this.setupListeners();
    console.log('[MockTTS] Started — logger til console (Phase 1: Kokoro TTS)');
  }

  private setupListeners(): void {
    bus.on('tts:speaking', async (data) => {
      const words = data.text.split(' ').length;
      const duration = Math.max(1500, words * 180); // ~180ms per word

      console.log(`\n🔊 [Grace]: ${data.text}\n`);

      // Simulate the time it takes to speak
      await new Promise(r => setTimeout(r, duration));

      bus.emit('tts:done', { sessionId: data.sessionId });
    });
  }
}
