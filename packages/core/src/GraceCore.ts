// ─────────────────────────────────────────────
// GraceCore — central orchestrator
//
// Routes: STT → LLM → TTS
// Enforces Discreet Mode (no logging)
// Enforces Field Notes Mode (no LLM/TTS — buffer raw notes)
// Enforces Paused/Sleeping (ignore all STT input)
// Handles power:fieldNotesSummaryReady → auto-summarise
// ─────────────────────────────────────────────


import { bus } from './EventBus.js';
import { GraceMemory } from './memory.js';
import type { GraceConfig, GraceMode, GracePowerState, ConversationTurn } from '@grace/shared';

export class GraceCore {
  private config: GraceConfig;
  private mode: GraceMode = 'normal';
  private powerState: GracePowerState = 'active';
  private history: ConversationTurn[] = [];
  private isProcessing = false;
  private fieldNoteBuffer: string[] = [];
  private memory = new GraceMemory();
  private sessionId = `sess-${Date.now()}`;

  constructor(config: GraceConfig) {
    this.config = config;
    this.init();
  }

  // ── Init ────────────────────────────────────

  private init(): void {
    // Restore recent conversation so context + memory survive restarts.
    const restored = this.memory.recentTurns(8);
    if (restored.length) {
      this.history = restored.map(t => ({
        role: t.role, content: t.content,
        timestamp: new Date(t.ts), sessionId: t.session, persist: true,
      }));
      console.log(`[Core] Restored ${restored.length} turns from memory (${this.memory.engine}).`);
    }

    // ── STT → route based on power state ──────
    bus.on('stt:heard', ({ text, sessionId }) => {
      if (this.powerState === 'paused' || this.powerState === 'sleeping') {
        return; // Grace is fully off — ignore
      }

      if (this.powerState === 'field-notes') {
        // Battery mode: save raw note, no LLM
        this.saveFieldNote(text, sessionId);
        return;
      }

      if (this.isProcessing) return;
      this.isProcessing = true;

      if (this.mode !== 'discreet') {
        this.history.push({
          role: 'user', content: text,
          timestamp: new Date(), sessionId, persist: true,
        });
        this.memory.addTurn(this.sessionId, 'user', text);
      }

      // Build a compact history snapshot for the LLM (last 20 turns)
      const historySnapshot = this.history.slice(-20).map(t => ({
        role: t.role === 'grace' ? 'assistant' : 'user',
        content: t.content,
      }));

      bus.emit('overlay:show', { type: 'thinking' });
      bus.emit('llm:thinking', { sessionId, text, history: historySnapshot });
    });

    // ── LLM response ──────────────────────────
    bus.on('llm:response', (response) => {
      // Selective responding: empty text = Grace chose not to reply (<SKIP>).
      // No TTS will follow, so reset here and go straight back to listening.
      if (!response.text?.trim()) {
        console.log('[Grace] 🤐 (stayed silent — <SKIP>)');
        this.isProcessing = false;
        bus.emit('overlay:show', { type: 'listening' });
        return;
      }

      // Log Grace's actual reply so it shows up in the terminal logs.
      console.log(`[Grace] 💬 ${response.text}`);

      if (this.mode !== 'discreet') {
        this.history.push({
          role: 'grace', content: response.text,
          timestamp: new Date(), sessionId: response.sessionId, persist: true,
        });
        this.memory.addTurn(this.sessionId, 'grace', response.text);
      }

      bus.emit('overlay:show', { type: 'speaking', data: { text: response.text } });
      // If the provider already streamed the speech (spoken), don't re-speak it.
      if (!response.spoken) {
        bus.emit('tts:speaking', { text: response.text, sessionId: response.sessionId });
      }

      if (response.toolCalls?.length) {
        response.toolCalls.forEach(tc => bus.emit('tool:execute', tc));
      }
    });

    // ── TTS done ──────────────────────────────
    bus.on('tts:done', () => {
      setTimeout(() => {
        this.isProcessing = false;
        bus.emit('overlay:show', { type: 'listening' });
      }, 500);
    });

    // ── Mode change ───────────────────────────
    bus.on('system:modeChange', ({ mode, reason }) => {
      const prev = this.mode;
      this.mode = mode;
      console.log(`[Core] Mode: ${prev} → ${mode}${reason ? ` (${reason})` : ''}`);

      if (mode === 'discreet') {
        bus.emit('overlay:notification', {
          text: '🔒 Diskret Mode — nul data gemmes',
          level: 'info', duration: 3500,
        });
      } else if (prev === 'discreet') {
        bus.emit('overlay:notification', {
          text: '✓ Diskret Mode afsluttet',
          level: 'info', duration: 2000,
        });
      }
    });

    // ── Power state change ────────────────────
    bus.on('power:stateChange', ({ state, reason }) => {
      const prev = this.powerState;
      this.powerState = state;
      console.log(`[Core] Power: ${prev} → ${state} (${reason})`);

      if (state === 'field-notes') {
        bus.emit('overlay:show', { type: 'field-notes' });
      } else if (state === 'active' && prev === 'field-notes') {
        bus.emit('overlay:show', { type: 'listening' });
      } else if (state === 'paused' || state === 'sleeping') {
        bus.emit('overlay:show', { type: 'paused' });
      }
    });

    // ── Field notes summary on AC reconnect ───
    bus.on('power:fieldNotesSummaryReady', ({ noteCount, sessionStart }) => {
      if (noteCount === 0) return;

      const notes = this.fieldNoteBuffer.join('\n---\n');
      this.fieldNoteBuffer = [];

      const sid = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const duration = sessionStart
        ? Math.round((Date.now() - sessionStart.getTime()) / 60000)
        : 0;

      const prompt =
        `Du var med til et møde/session der varede ca. ${duration} minutter. ` +
        `Her er dine rånoter:\n\n${notes}\n\n` +
        `Opsummér: hvad blev aftalt, hvad skal jeg lave, vigtige detaljer. ` +
        `Vær konkret og handlingsorienteret.`;

      bus.emit('overlay:notification', {
        text: `📓 Opsummerer ${noteCount} noter fra dagens session…`,
        level: 'info', duration: 5000,
      });

      this.isProcessing = true;

      // Inject the summarisation prompt as a synthetic user turn
      this.history.push({
        role: 'user', content: prompt,
        timestamp: new Date(), sessionId: sid, persist: true,
      });

      bus.emit('llm:thinking', { sessionId: sid, text: prompt });
    });
  }

  // ── Field note buffering ─────────────────────

  private saveFieldNote(text: string, sessionId: string): void {
    const ts = new Date().toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
    const note = `[${ts}] ${text}`;
    this.fieldNoteBuffer.push(note);
    console.log(`[Core] Field note: ${note}`);

    // Show subtle overlay notification (no TTS in field-notes mode)
    bus.emit('overlay:notification', {
      text: `📓 ${text.length > 60 ? text.slice(0, 57) + '…' : text}`,
      level: 'info', duration: 3000,
    });
  }

  // ── Public API ───────────────────────────────

  /** A spoken greeting for startup; recalls the previous session if there was one. */
  getStartupGreeting(): string {
    const recall = this.memory.lastSessionRecall(this.sessionId);
    if (recall) {
      const s = recall.length > 90 ? recall.slice(0, 87) + '...' : recall;
      return `Hey Mikkel, Grace is back online. Last time you were on about: ${s}. Want to pick that back up, or start fresh?`;
    }
    return `Hey Mikkel, Grace here — online and ready to go.`;
  }

  getMode(): GraceMode { return this.mode; }
  getPowerState(): GracePowerState { return this.powerState; }
  getHistory(): ConversationTurn[] { return [...this.history]; }

  setMode(mode: GraceMode): void {
    bus.emit('system:modeChange', { mode, reason: 'api' });
  }

  clearHistory(): void { this.history = []; }
}
