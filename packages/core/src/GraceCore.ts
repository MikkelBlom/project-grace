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

// Hold-the-floor / "listen mode" trigger phrases (case-insensitive, DA + EN).
// START → Grace goes silent and buffers everything you say until an END phrase, then
// answers the whole thing at once. Lets you explain complex ideas with pauses.
const LISTEN_START_RE = /(let me explain|let me think out loud|hold on,? let me|don'?t interrupt|don'?t respond yet|listen up|hear me out|lad mig forklare|lad mig tale ud|lad mig tænke højt|hør (her|efter)|lyt (nu|lige)|afbryd mig ikke|jeg (skal|vil) (lige )?forklare)/i;
const LISTEN_END_RE = /(i'?m done|that'?s it|that'?s all|i'?m finished|over to you|your turn|go ahead now|jeg er færdig|det var det|det var alt|din tur|værsgo|så er jeg færdig|nu kan du svare|nu er det din tur|okay,? kør|kør nu)/i;

export class GraceCore {
  private config: GraceConfig;
  private mode: GraceMode = 'normal';
  private powerState: GracePowerState = 'active';
  private history: ConversationTurn[] = [];
  private isProcessing = false;
  private fieldNoteBuffer: string[] = [];
  private listenMode = false;          // "hold the floor" — buffer speech until you say you're done
  private listenBuffer: string[] = [];
  private memory = new GraceMemory();
  private sessionId = `sess-${Date.now()}`;

  constructor(config: GraceConfig) {
    this.config = config;
    this.init();
  }

  // ── Init ────────────────────────────────────

  private init(): void {
    // Restore recent conversation so context + memory survive restarts.
    const restored = this.memory.recentTurns(4);
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

      let utterance = text;

      // ── Hold-the-floor / listen mode ──────────
      const lower = utterance.trim().toLowerCase();
      if (this.listenMode) {
        if (LISTEN_END_RE.test(lower)) {
          // Combine everything buffered (minus the closing phrase) and dispatch as one turn.
          utterance = this.exitListenMode(false, utterance.trim());
          console.log(`[Core] 🎧 listen mode OFF — processing ${utterance.length} chars`);
          if (!utterance) { bus.emit('overlay:show', { type: 'listening' }); return; }
          // fall through to normal dispatch with the combined text
        } else {
          this.listenBuffer.push(utterance.trim());
          console.log(`[Core] 🎧 holding (${this.listenBuffer.length} parts): "${utterance.trim().slice(0, 60)}"`);
          bus.emit('overlay:show', { type: 'listening' });
          return; // stay silent, keep listening across the pause
        }
      } else if (LISTEN_START_RE.test(lower)) {
        this.enterListenMode(sessionId);
        return;
      }

      if (this.isProcessing) return;
      this.isProcessing = true;

      if (this.mode !== 'discreet') {
        this.history.push({
          role: 'user', content: utterance,
          timestamp: new Date(), sessionId, persist: true,
        });
        this.memory.addTurn(this.sessionId, 'user', utterance);
      }

      // Build a compact history snapshot for the LLM (last 20 turns)
      const historySnapshot = this.history.slice(-20).map(t => ({
        role: t.role === 'grace' ? 'assistant' : 'user',
        content: t.content,
      }));

      bus.emit('overlay:show', { type: 'thinking' });
      bus.emit('llm:thinking', { sessionId, text: utterance, history: historySnapshot });
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

    // ── TTS state tracking ────────────────────
    bus.on('tts:speaking', () => {
      bus.emit('stt:pause', {});
    });

    bus.on('tts:done', () => {
      bus.emit('stt:resume', {});
      setTimeout(() => {
        this.isProcessing = false;
        bus.emit('overlay:show', { type: 'listening' });
      }, 500);
    });

    // ── Control: barge-in / interrupt ─────────
    // GraceCore owns its OWN state here (processing flag, listen mode, overlay). TTS stops
    // speech via its own control:stop subscription; OllamaLLM cancels any task/mission and
    // speaks the context-aware ack (it holds the task state). Splitting it this way keeps
    // a single spoken ack and avoids two subsystems talking over each other.
    bus.on('control:stop', ({ reason } = {}) => {
      console.log(`[Core] ⏹ STOP${reason ? ` (${reason})` : ''}`);
      if (this.listenMode) this.exitListenMode(true);   // discard the held buffer
      this.isProcessing = false;
      bus.emit('tts:stop', {});                         // belt-and-braces: flush speech regardless of subscriber order
      bus.emit('overlay:show', { type: 'listening' });
    });

    bus.on('control:pause', () => { bus.emit('overlay:show', { type: 'thinking' }); });
    bus.on('control:resume', () => { bus.emit('overlay:show', { type: 'thinking' }); });

    // Toggle listen mode from a hotkey or the enter_listen_mode tool.
    bus.on('control:listenMode', ({ on }) => {
      if (on && !this.listenMode) this.enterListenMode(`ctl-${Date.now()}`);
      else if (!on && this.listenMode) {
        const combined = this.exitListenMode(false);
        if (combined) {
          this.isProcessing = true;
          this.history.push({ role: 'user', content: combined, timestamp: new Date(), sessionId: this.sessionId, persist: true });
          this.memory.addTurn(this.sessionId, 'user', combined);
          const snap = this.history.slice(-20).map(t => ({ role: t.role === 'grace' ? 'assistant' : 'user', content: t.content }));
          bus.emit('overlay:show', { type: 'thinking' });
          bus.emit('llm:thinking', { sessionId: this.sessionId, text: combined, history: snap });
        } else {
          bus.emit('overlay:show', { type: 'listening' });
        }
      }
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

  // ── Listen mode ("hold the floor") ───────────

  /** Go silent and start buffering everything heard until an END phrase / hotkey / tool releases it. */
  private enterListenMode(sessionId: string): void {
    this.listenMode = true;
    this.listenBuffer = [];
    console.log('[Core] 🎧 listen mode ON — buffering until you say you are done');
    bus.emit('overlay:show', { type: 'listening' });
    bus.emit('tts:speaking', { text: 'Jeg lytter — tag dig god tid, og sig til når du er klar.', sessionId });
  }

  /**
   * Leave listen mode. With `discard`, drop the buffer and return ''. Otherwise append
   * `lastPart` (the closing utterance, which often carries the actual instruction) and
   * return the whole buffered text as one combined utterance.
   */
  private exitListenMode(discard: boolean, lastPart = ''): string {
    this.listenMode = false;
    if (discard) { this.listenBuffer = []; return ''; }
    if (lastPart) this.listenBuffer.push(lastPart);
    const combined = this.listenBuffer.join(' ').replace(/\s+/g, ' ').trim();
    this.listenBuffer = [];
    return combined;
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
    // A warm, varied greeting — not a verbatim parrot of the last message.
    const lines = [
      'Hey Mikkel, Grace is back online. What are we working on?',
      'Grace here, booted and ready. What do you need?',
      'Back online. Pick up where we left off, or start something new?',
      'Hey Mikkel, I am up and ready to go. What is on your mind?',
    ];
    return lines[Math.floor(Math.random() * lines.length)]!;
  }

  getMode(): GraceMode { return this.mode; }
  getPowerState(): GracePowerState { return this.powerState; }
  getHistory(): ConversationTurn[] { return [...this.history]; }

  setMode(mode: GraceMode): void {
    bus.emit('system:modeChange', { mode, reason: 'api' });
  }

  clearHistory(): void { this.history = []; }
}
