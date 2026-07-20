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
import { graceMemory } from './memory.js';
import { settings } from './settings.js';
import { sttCorrections } from './sttCorrections.js';
import type { GraceConfig, GraceMode, GracePowerState, ConversationTurn } from '@grace/shared';

// Hold-the-floor / "listen mode" trigger phrases (case-insensitive, DA + EN).
// START → Grace goes silent and buffers everything you say until an END phrase, then
// answers the whole thing at once. Lets you explain complex ideas with pauses.
// Explicit, unambiguous "hold the floor" phrases — these enter listen mode immediately,
// no asking. (Less explicit hints are handled semantically by the LLM via enter_listen_mode,
// which asks Mikkel to confirm first.)
const LISTEN_START_RE = /(let me explain|let me think out loud|hold on,? let me|don'?t interrupt|don'?t respond yet|listen up|hear me out|just listen|lad mig forklare|lad mig (snakke|tale|tænke) (ud|færdig|højt)|lad mig tale ud|hør (her|efter)|lytte? efter|slå (dine )?lyttelapper(ne)? ud|du skal (bare |lige )?lytte|bare lyt|lyt(te)?[- ]?mode|lyt (nu|lige)|afbryd mig ikke|jeg (skal|vil) (lige )?forklare)/i;
// Releasing listen mode is STT-fragile: Whisper hears "gå i gang" as "god i gang", "go i gang",
// even "I O I gang" — so we match the strong token "i gang" regardless of the verb, plus other
// explicit "go/done" phrases. STRONG_END matches at any length; SHORT_GO only on short, command-like
// utterances (so an "i gang"/"start" buried in a long explanation sentence doesn't end it early).
const LISTEN_END_STRONG_RE = /(i'?m done|that'?s it|that'?s all|i'?m finished|over to you|your turn|go ahead|jeg er færdig|så er jeg færdig|det var det|det var alt|din tur|nu er det din tur|nu kan du svare|værsgo|du må gerne (begynd|gå|start|kør)|du kan (godt )?(svare|starte|gå i gang|begynd))/i;
const LISTEN_END_SHORT_RE = /(\bi gang\b|(g[åo]+d?|go) i gang|kom i gang|sæt i gang|\bstart\b|start( nu| opgaven| missionen)?|\bbegynd(e)?\b|\bkør\b|go ahead|^\s*(gå|go)\s*[.!]?\s*$|\bbegin\b)/i;
function isListenEnd(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return LISTEN_END_STRONG_RE.test(lower) || (lower.length <= 32 && LISTEN_END_SHORT_RE.test(lower));
}

// Voice control fast-path — short, command-like utterances that map straight to control:*
// events, so Mikkel can stop/pause/resume/ask for status by voice even while a mission runs
// (anchored + only on short utterances, so a "stop" mid-explanation doesn't false-trigger).
const CTRL_STOP_RE   = /^(stop|stop nu|stop det|stop arbejdet|hold op|hold da op|afbryd|cancel|abort)\b/i;
const CTRL_PAUSE_RE  = /^(pause|pausér|pauser|sæt (det )?på pause|hold (en )?pause|vent lige)\b/i;
const CTRL_RESUME_RE = /^(fortsæt|forsæt|kør videre|genoptag|resume)\b/i;
const CTRL_STATUS_RE = /^(status|statusrapport|hvor langt er du( med.*)?|giv (mig )?(en )?status(rapport)?)\b/i;
// Language switch by voice (instant, no LLM round-trip). English mode for English-speaking guests.
const CTRL_LANG_EN_RE = /^(switch to english|talk(ing)? english|speak(ing)? english|let'?s speak english|in english( now| please)?|english (please|now|mode)|kan (vi|du) (snakke|tale) engelsk)\b/i;
const CTRL_LANG_DA_RE = /^(skift til dansk|tal(er)? dansk|på dansk( igen| nu| tak)?|snak(ker)? dansk|dansk (igen|nu|tak|mode)|switch to danish|speak danish|danish (please|now|mode))\b/i;
// Short, safety-critical words: a misheard one of these could gate a file deletion. If STT reports
// low confidence for a bare one of these, we re-ask instead of acting on a guess.
const CRITICAL_YESNO_RE = /^(ja|jo|nej|nå|jaja|yes|yeah|yep|no|nope|slet( den| dem)?|delete|gør det|do it|bekræft|confirm|okay|ok)\.?$/i;

// ── Context-window management ────────────────────────────────────────────────
// The LLM runs with num_ctx = 128K. Grace feeds it as much REAL conversation as fits in a
// generous token budget (newest-first) instead of a fixed 20-turn window. Only when a
// conversation genuinely outgrows the budget — many hours of talk — do the oldest turns fold
// into a rolling summary so their facts survive instead of silently dropping out of context.
const LLM_HISTORY_TOKEN_BUDGET = 80_000;   // ~80K tokens of verbatim history; leaves ~48K of the
                                           // 128K window for the system prompt, memory blocks,
                                           // large tool results and the reply. Covers hours of speech.
const TURN_TOKEN_OVERHEAD = 4;             // per-turn role/message framing
function estimateTokens(text: string): number {
  // Cheap char-based estimate (~4 chars/token) — matches the heuristics used elsewhere in Grace.
  return Math.ceil((text?.length ?? 0) / 4) + TURN_TOKEN_OVERHEAD;
}

export class GraceCore {
  private config: GraceConfig;
  private mode: GraceMode = 'normal';
  private powerState: GracePowerState = 'active';
  private history: ConversationTurn[] = [];
  // STT confidence below this, for a short critical yes/no/confirm word, triggers a re-ask instead
  // of acting (see the safety gate in stt:heard). Tune once the whisper server emits real logprobs.
  private static readonly LOW_STT_CONFIDENCE = 0.55;
  private _isProcessing = false;
  private processingWatchdog: ReturnType<typeof setTimeout> | null = null;
  // Watchdog: normally `tts:done` clears isProcessing. If TTS never completes (e.g. a hung playback
  // child), Grace would stay "processing" and go deaf forever. This is an IDLE watchdog, not a total-
  // turn cap: it's re-armed on every sign of progress (llm:thinking, tool:result), so a legitimately
  // long multi-step turn keeps resetting it and only a genuinely HUNG turn (no progress for the
  // interval) resets to listening. A fixed 240s total cap fired mid-turn on long research turns,
  // freeing the mic and letting a second turn start concurrently — this avoids that.
  private static readonly WATCHDOG_IDLE_MS = 240_000;
  private get isProcessing(): boolean { return this._isProcessing; }
  private set isProcessing(v: boolean) {
    this._isProcessing = v;
    if (v) this.armWatchdog();
    else if (this.processingWatchdog) { clearTimeout(this.processingWatchdog); this.processingWatchdog = null; }
  }
  private armWatchdog(): void {
    if (this.processingWatchdog) clearTimeout(this.processingWatchdog);
    this.processingWatchdog = setTimeout(() => {
      console.warn('[Core] ⏱ processing watchdog — no progress for 240s; resetting so Grace can listen again.');
      this._isProcessing = false;
      this.processingWatchdog = null;
      bus.emit('stt:resume', {});
      bus.emit('overlay:show', { type: (this.powerState === 'paused' || this.powerState === 'sleeping') ? 'paused' : 'listening' });
    }, GraceCore.WATCHDOG_IDLE_MS);
  }
  private fieldNoteBuffer: string[] = [];
  private listenMode = false;          // "hold the floor" — buffer speech until you say you're done
  private listenBuffer: string[] = [];
  // Use the shared singleton — OllamaLLM, recall_memory and every tool read/write the SAME
  // GraceMemory. A second `new GraceMemory()` here used to fight the singleton over the same
  // JSON files (last-writer-wins races; same-session recall returning nothing when Chroma was down).
  private memory = graceMemory;
  private sessionId = `sess-${Date.now()}`;
  // Rolling summary of conversation turns that have aged out of the live token budget. Empty until
  // a conversation actually overflows (rare). summarizedThrough = count of leading history turns
  // already folded into rollingSummary, so we never re-summarise the same turn twice.
  private rollingSummary = '';
  private summarizedThrough = 0;
  // Voice barge-in: keep the mic OPEN while Grace speaks so a spoken "stop" lands mid-sentence.
  // Safe when output is in-ear (earbuds) + mic is the laptop's — on laptop SPEAKERS this would
  // feed her own voice back, so it's opt-in. Enable with GRACE_VOICE_BARGEIN=1.
  private bargeIn = process.env.GRACE_VOICE_BARGEIN === '1' || process.env.GRACE_VOICE_BARGEIN === 'true';
  // Dynamic contextual STT bias (opt-in): feed recently-mentioned proper nouns back to the STT as
  // hotwords so names Grace just said are heard right next turn. Off by default — hotword-piling can
  // hurt WER, so this stays bounded (12) and only runs when GRACE_STT_DYNAMIC_BIAS=1.
  private dynamicBias = process.env.GRACE_STT_DYNAMIC_BIAS === '1';
  private recentBiasTerms: string[] = [];
  // Auto language switch (opt-in GRACE_AUTO_LANG): if a transcript is clearly the other language,
  // flip the language mode. Text-based (no STT-server change), conservative to avoid flip-flopping.
  private autoLang = process.env.GRACE_AUTO_LANG === '1';

  constructor(config: GraceConfig) {
    this.config = config;
    this.init();
  }

  // ── Init ────────────────────────────────────

  private init(): void {
    // Restore recent conversation so context + memory survive restarts. Restore generously — the
    // LLM's token budget (not this count) governs how much is actually shown, and spoken turns are
    // short, so this gives real cross-session continuity instead of the old 4-turn stub.
    const restored = this.memory.recentTurns(500);
    if (restored.length) {
      this.history = restored.map(t => ({
        role: t.role, content: t.content,
        timestamp: new Date(t.ts), sessionId: t.session, persist: true,
      }));
      console.log(`[Core] Restored ${restored.length} turns from memory (${this.memory.engine}).`);
    }

    // ── STT → route based on power state ──────
    bus.on('stt:heard', async ({ text: rawText, sessionId, confidence }) => {
      // Deterministic post-ASR correction (Mikkel's curated name/term fixes) before anything else.
      const text = sttCorrections.apply(rawText);
      if (this.powerState === 'paused' || this.powerState === 'sleeping') {
        return; // Grace is fully off — ignore
      }

      if (this.powerState === 'field-notes') {
        // Battery mode: save raw note, no LLM
        this.saveFieldNote(text, sessionId);
        return;
      }

      // Safety gate: a short, critical yes/no/confirm word heard with LOW confidence can gate a
      // delete — never act on a guess. Ask Mikkel to repeat rather than pass an ambiguous signal on.
      if (typeof confidence === 'number' && confidence < GraceCore.LOW_STT_CONFIDENCE
          && CRITICAL_YESNO_RE.test(text.trim())) {
        console.warn(`[Core] ⚠ low-confidence critical word "${text}" (conf=${confidence.toFixed(2)}) — re-asking instead of acting`);
        bus.emit('tts:speaking', {
          text: settings.language === 'da' ? 'Undskyld, det hørte jeg ikke helt — kan du gentage?' : "Sorry, I didn't quite catch that — can you repeat?",
          sessionId,
        });
        return;
      }

      this.updateBiasFrom(text);   // bias STT toward proper nouns Mikkel just used (opt-in)
      this.maybeAutoSwitchLanguage(text);   // flip DA/EN if the utterance is clearly the other language (opt-in)
      let utterance = text;

      // ── Voice control fast-path (stop / pause / resume / status) ──
      // Runs BEFORE the isProcessing guard and listen mode so it works even mid-work.
      const u = utterance.trim();
      if (u.length <= 30) {
        if (CTRL_STOP_RE.test(u))   { console.log('[Core] 🎙 voice STOP');   bus.emit('control:stop',   { reason: 'voice' }); return; }
        if (CTRL_PAUSE_RE.test(u))  { console.log('[Core] 🎙 voice PAUSE');  bus.emit('control:pause',  { reason: 'voice' }); return; }
        if (CTRL_RESUME_RE.test(u)) { console.log('[Core] 🎙 voice RESUME'); bus.emit('control:resume', { reason: 'voice' }); return; }
        if (CTRL_STATUS_RE.test(u)) { console.log('[Core] 🎙 voice STATUS'); bus.emit('control:status', {}); return; }
      }
      // Language switch — allow slightly longer phrases than the stop/pause set.
      if (u.length <= 40) {
        if (CTRL_LANG_EN_RE.test(u)) {
          settings.setLanguage('en'); console.log('[Core] 🌐 language → English');
          bus.emit('tts:speaking', { text: 'Okay, switching to English.', sessionId }); return;
        }
        if (CTRL_LANG_DA_RE.test(u)) {
          settings.setLanguage('da'); console.log('[Core] 🌐 language → Danish');
          bus.emit('tts:speaking', { text: 'Så skifter vi til dansk.', sessionId }); return;
        }
      }

      // ── Hold-the-floor / listen mode ──────────
      const lower = utterance.trim().toLowerCase();
      if (this.listenMode) {
        if (isListenEnd(utterance)) {
          // Combine everything buffered (minus the closing phrase) and dispatch as one turn.
          utterance = this.exitListenMode(false, utterance.trim());
          console.log(`[Core] 🎧 listen mode OFF — processing ${utterance.length} chars`);
          if (!utterance) { bus.emit('overlay:show', { type: 'listening' }); return; }
          // fall through to normal dispatch with the combined text
        } else {
          const cur = utterance.trim();
          this.listenBuffer.push(cur);
          const n = this.listenBuffer.length;
          // Safety net: a short phrase repeated back-to-back means Mikkel is trying to end listen
          // mode but STT isn't matching the end phrase — release rather than leave him stuck.
          if (n >= 2 && cur.length <= 20 && cur.toLowerCase() === this.listenBuffer[n - 2]!.trim().toLowerCase()) {
            this.listenBuffer.splice(n - 2, 2);            // drop both repeats (the failed end signal)
            utterance = this.exitListenMode(false);        // dispatch everything said before them
            console.log('[Core] 🎧 listen mode OFF — released on a repeated phrase');
            if (!utterance) { bus.emit('overlay:show', { type: 'listening' }); return; }
            // fall through to normal dispatch with the combined text
          } else {
            console.log(`[Core] 🎧 holding (${n} parts): "${cur.slice(0, 60)}"`);
            bus.emit('overlay:show', { type: 'listening' });
            return; // stay silent, keep listening across the pause
          }
        }
      } else if (LISTEN_START_RE.test(lower)) {
        this.enterListenMode(sessionId);
        return;
      }

      if (this.isProcessing) return;
      this.isProcessing = true;

      // Anything after the guard is wrapped: if an await here rejects (e.g. building history), we must
      // clear isProcessing and resume listening — otherwise the turn strands and Grace goes deaf until
      // the watchdog. On success the normal tts:done path clears the flag.
      try {
        if (this.mode !== 'discreet') {
          this.history.push({
            role: 'user', content: utterance,
            timestamp: new Date(), sessionId, persist: true,
          });
          this.memory.addTurn(this.sessionId, 'user', utterance);
        }

        // Feed the LLM as much real conversation as fits its token budget (not a fixed 20-turn
        // window) — older turns fold into a rolling summary rather than vanishing from context.
        const historySnapshot = await this.buildHistoryForLLM();

        bus.emit('overlay:show', { type: 'thinking' });
        bus.emit('llm:thinking', { sessionId, text: utterance, history: historySnapshot });
      } catch (err) {
        console.error('[Core] stt:heard handler failed — resetting to listening:', err);
        this.isProcessing = false;
        bus.emit('stt:resume', {});
        bus.emit('overlay:show', { type: 'listening' });
      }
    });

    // ── LLM response ──────────────────────────
    bus.on('llm:response', (response) => {
      // Selective responding: empty text = Grace chose not to reply (<SKIP>).
      // No TTS will follow, so reset here and go straight back to listening.
      if (!response.text?.trim()) {
        console.log('[Grace] 🤐 (stayed silent — <SKIP>)');
        this.isProcessing = false;
        bus.emit('overlay:show', { type: (this.powerState === 'paused' || this.powerState === 'sleeping') ? 'paused' : 'listening' });
        return;
      }

      // Log Grace's actual reply so it shows up in the terminal logs.
      console.log(`[Grace] 💬 ${response.text}`);
      this.updateBiasFrom(response.text);   // bias STT toward names Grace just used (opt-in)

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
      // Normally pause the mic so Grace doesn't transcribe herself. With voice barge-in on,
      // keep it open so a spoken "stop"/"pause" reaches the control fast-path mid-speech;
      // ordinary speech during her turn is still ignored by the isProcessing guard.
      if (!this.bargeIn) bus.emit('stt:pause', {});
    });

    bus.on('tts:done', () => {
      bus.emit('stt:resume', {});
      setTimeout(() => {
        this.isProcessing = false;
        bus.emit('overlay:show', { type: (this.powerState === 'paused' || this.powerState === 'sleeping') ? 'paused' : 'listening' });
      }, 500);
    });

    // Re-arm the idle watchdog on every sign of progress so a long-but-active turn is never reset
    // mid-flight; only a turn that stops making progress for the interval trips it.
    bus.on('llm:thinking', () => { if (this._isProcessing) this.armWatchdog(); });
    bus.on('tool:result', () => { if (this._isProcessing) this.armWatchdog(); });

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
      bus.emit('overlay:show', { type: (this.powerState === 'paused' || this.powerState === 'sleeping') ? 'paused' : 'listening' });
    });

    bus.on('control:pause', () => { bus.emit('overlay:show', { type: 'thinking' }); });
    bus.on('control:resume', () => { bus.emit('overlay:show', { type: 'thinking' }); });

    // Toggle listen mode from a hotkey or the enter_listen_mode tool.
    bus.on('control:listenMode', async ({ on }) => {
      if (on && !this.listenMode) this.enterListenMode(`ctl-${Date.now()}`);
      else if (!on && this.listenMode) {
        const combined = this.exitListenMode(false);
        if (combined) {
          this.isProcessing = true;
          this.history.push({ role: 'user', content: combined, timestamp: new Date(), sessionId: this.sessionId, persist: true });
          this.memory.addTurn(this.sessionId, 'user', combined);
          const snap = await this.buildHistoryForLLM();
          bus.emit('overlay:show', { type: 'thinking' });
          bus.emit('llm:thinking', { sessionId: this.sessionId, text: combined, history: snap });
        } else {
          bus.emit('overlay:show', { type: (this.powerState === 'paused' || this.powerState === 'sleeping') ? 'paused' : 'listening' });
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
        if (!this.isProcessing) {
          bus.emit('overlay:show', { type: 'paused' });
        }
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
    bus.emit('tts:speaking', { text: "I'm listening — take your time, and tell me when you're ready.", sessionId });
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

  // ── Context-window assembly ────────────────────────────────────────────────
  // Build the history the LLM actually sees: as many of the most-recent turns as fit in the token
  // budget, in chronological order. If older turns must be dropped, they are first folded into a
  // rolling summary that is prepended, so no earlier fact is lost.
  private async buildHistoryForLLM(): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const turns = this.history;

    // Walk newest → oldest, keeping turns until the budget is spent.
    let used = 0;
    let keepFrom = turns.length;
    for (let i = turns.length - 1; i >= 0; i--) {
      const cost = estimateTokens(turns[i]!.content);
      if (used + cost > LLM_HISTORY_TOKEN_BUDGET && keepFrom < turns.length) break;
      used += cost;
      keepFrom = i;
    }

    // Anything before keepFrom drops out of the verbatim window — fold the not-yet-summarised
    // dropped turns into the rolling summary so their facts persist (only fires on real overflow).
    if (keepFrom > this.summarizedThrough) {
      const toFold = turns.slice(this.summarizedThrough, keepFrom);
      if (toFold.length) {
        this.rollingSummary = await this.summarizeTurns(this.rollingSummary, toFold);
        this.summarizedThrough = keepFrom;
      }
    }

    const kept: Array<{ role: 'user' | 'assistant'; content: string }> = turns.slice(keepFrom).map(t => ({
      role: t.role === 'grace' ? 'assistant' : 'user',
      content: t.content,
    }));

    if (this.rollingSummary && keepFrom > 0) {
      kept.unshift({
        role: 'user',
        content: `CONVERSATION SO FAR — summary of earlier parts of this conversation (older messages that no longer fit verbatim). Treat these as things that were actually said; do not contradict or forget them:\n${this.rollingSummary}`,
      });
    }
    return kept;
  }

  // Summarise turns that have aged out of the live budget, folding in any prior summary, via a
  // lightweight tool-free Ollama call. Only runs on genuine overflow (rare), so the added latency
  // is acceptable. GraceCore and OllamaLLM are bus-decoupled, so this talks to Ollama directly
  // using the same env config the LLM adapter uses.
  private async summarizeTurns(existingSummary: string, toFold: ConversationTurn[]): Promise<string> {
    const transcript = toFold.map(t => `${t.role === 'grace' ? 'Grace' : 'Mikkel'}: ${t.content}`).join('\n');
    const prior = existingSummary ? `EXISTING SUMMARY so far:\n${existingSummary}\n\n` : '';
    const prompt =
      `${prior}EARLIER CONVERSATION TURNS to fold into the summary:\n${transcript}\n\n` +
      `Write a single updated summary of the conversation so far, in Danish. Preserve every concrete ` +
      `fact, decision, name, number and preference, and anything Mikkel might refer back to. Be concise ` +
      `but do NOT drop facts. Output only the summary text, nothing else.`;
    try {
      const url = process.env.GRACE_OLLAMA_URL ?? 'http://localhost:11434';
      const model = process.env.GRACE_LLM_MODEL ?? this.config.llm.model ?? 'gemma4:26b';
      const res = await fetch(`${url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, prompt, stream: false, think: false,
          options: { temperature: 0.2, num_ctx: 131072, num_predict: 1024 },
          keep_alive: -1,
        }),
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
      const data = await res.json() as { response?: string };
      const summary = (data.response ?? '').trim();
      if (summary) {
        console.log(`[Core] 🧵 Folded ${toFold.length} aged-out turn(s) into rolling summary (${summary.length} chars).`);
        return summary;
      }
    } catch (err) {
      console.warn('[Core] Rolling-summary failed — keeping a raw transcript fallback:', err);
    }
    // Fallback: if summarisation fails, keep a compact raw transcript so facts still survive.
    const rawFold = toFold.map(t => `${t.role === 'grace' ? 'Grace' : 'Mikkel'}: ${t.content}`).join('\n');
    return [existingSummary, rawFold].filter(Boolean).join('\n');
  }

  // ── Dynamic contextual STT bias (opt-in) ─────────────────────────────────────
  private extractProperNouns(text: string): string[] {
    const matches = text.match(/\b[A-ZÆØÅ][A-Za-zÆØÅæøå0-9.+#-]{2,}\b/g) ?? [];
    const stop = new Set(['The', 'This', 'That', 'And', 'But', 'You', 'Your', 'For', 'With', 'Jeg', 'Det',
      'Den', 'Der', 'Han', 'Hun', 'Men', 'Hvad', 'Hvor', 'Hvorfor', 'Hvordan', 'Okay', 'Grace']);
    return matches.filter((w) => !stop.has(w));
  }

  private updateBiasFrom(text: string): void {
    if (!this.dynamicBias || !text) return;
    const nouns = this.extractProperNouns(text);
    if (!nouns.length) return;
    const merged = [...new Set([...nouns, ...this.recentBiasTerms])].slice(0, 12);
    if (merged.join('|') !== this.recentBiasTerms.join('|')) {
      this.recentBiasTerms = merged;
      bus.emit('stt:setHotwords', { words: merged });
    }
  }

  private maybeAutoSwitchLanguage(text: string): void {
    if (!this.autoLang || !text) return;
    const t = text.toLowerCase();
    const da = (t.match(/[æøå]/g)?.length ?? 0) + (t.match(/\b(og|er|ikke|jeg|det|på|med|han|hun|hvad|hvor|kan|skal|vil|ikke|men)\b/g)?.length ?? 0);
    const en = (t.match(/\b(the|is|and|you|what|how|are|this|that|with|can|will|should|would|there)\b/g)?.length ?? 0);
    const cur = settings.language;
    if (cur === 'da' && en >= 3 && en > da * 2) {
      settings.setLanguage('en');
      bus.emit('overlay:notification', { text: '🌐 → English (auto)', level: 'info', duration: 3000 });
    } else if (cur === 'en' && da >= 2 && da > en * 2) {
      settings.setLanguage('da');
      bus.emit('overlay:notification', { text: '🌐 → Dansk (auto)', level: 'info', duration: 3000 });
    }
  }

  getMode(): GraceMode { return this.mode; }
  getPowerState(): GracePowerState { return this.powerState; }
  getHistory(): ConversationTurn[] { return [...this.history]; }

  setMode(mode: GraceMode): void {
    bus.emit('system:modeChange', { mode, reason: 'api' });
  }

  clearHistory(): void { this.history = []; }
}
