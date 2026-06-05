// ─────────────────────────────────────────────
// Grace PowerManager
//
// Monitors AC / battery state and transitions Grace between:
//
//   AC power   → GracePowerState 'active'   (full pipeline)
//   Battery    → GracePowerState 'field-notes' (VAD + light STT only)
//   Game/pause → GracePowerState 'paused'   (zero resources)
//
// Field Notes behaviour on battery:
//   - Whisper small/base instead of large-v3
//   - No LLM inference  — notes saved raw to buffer
//   - No TTS           — silent, overlay notifications only
//   - On AC reconnect  → LLM loads, auto-summarises session notes
//
// Fullscreen game detection:
//   Uses system:contextUpdate events.  When activeApp changes and
//   isFullscreen === true, Grace pauses itself.  Resumes when
//   fullscreen exits.
// ─────────────────────────────────────────────

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let powerMonitor: any;
try {
  powerMonitor = require('electron')?.powerMonitor;
} catch {
  // Not running inside Electron (e.g., running node scripts). Provide a safe stub.
  powerMonitor = {
    isOnBatteryPower: () => false,
    on: () => {},
  };
}
import { bus } from './EventBus.js';
import type { GracePowerState } from '@grace/shared';

interface FieldNote {
  timestamp: Date;
  text: string;
  sessionId: string;
}

export class PowerManager {
  private state: GracePowerState = 'active';
  private fieldNotes: FieldNote[] = [];
  private sessionStart: Date = new Date();
  private wasOnACBeforeGame = false;
  private autoPauseOnGame: boolean;
  private autoResumeOnAC: boolean;

  constructor(opts: { autoPauseOnGame: boolean; autoResumeOnAC: boolean }) {
    this.autoPauseOnGame = opts.autoPauseOnGame;
    this.autoResumeOnAC = opts.autoResumeOnAC;

    this.init();
  }

  // ── Public ──────────────────────────────────

  getState(): GracePowerState {
    return this.state;
  }

  /** Buffer a raw note captured in field-notes mode */
  addFieldNote(text: string, sessionId: string): void {
    this.fieldNotes.push({ timestamp: new Date(), text, sessionId });
    console.log(`[PowerManager] Field note #${this.fieldNotes.length} buffered`);
  }

  getFieldNotes(): FieldNote[] {
    return [...this.fieldNotes];
  }

  clearFieldNotes(): void {
    this.fieldNotes = [];
    this.sessionStart = new Date();
  }

  // ── Private ─────────────────────────────────

  private init(): void {
    // Determine initial state from current power source
    const onAC = powerMonitor.isOnBatteryPower() === false;
    this.transitionTo(onAC ? 'active' : 'field-notes', `Startup — ${onAC ? 'AC' : 'batteri'}`);

    // AC plugged in
    powerMonitor.on('on-ac', () => {
      console.log('[PowerManager] AC tilsluttet');
      bus.emit('power:acChange', { onAC: true });

      if (this.autoResumeOnAC && this.state === 'field-notes') {
        this.onACReconnect();
      }
    });

    // AC unplugged
    powerMonitor.on('on-battery', () => {
      console.log('[PowerManager] Kører på batteri');
      bus.emit('power:acChange', { onAC: false });

      if (this.state === 'active') {
        this.transitionTo('field-notes', 'Batteri — skifter til Field Notes Mode');
      }
    });

    // Fullscreen game detection via context updates
    bus.on('system:contextUpdate', ({ activeApp, isFullscreen }) => {
      if (!this.autoPauseOnGame) return;

      if (isFullscreen && this.state === 'active') {
        // Entering fullscreen game
        this.wasOnACBeforeGame = !powerMonitor.isOnBatteryPower();
        console.log(`[PowerManager] Fuldskærm detekteret (${activeApp}) — pauser Grace`);
        this.transitionTo('paused', `Spil/fuldskærm: ${activeApp}`);
      } else if (!isFullscreen && this.state === 'paused' && this.wasOnACBeforeGame) {
        // Exiting fullscreen — resume if we were active before
        console.log('[PowerManager] Fuldskærm afsluttet — genoptager Grace');
        this.transitionTo('active', 'Fuldskærm afsluttet');
      }
    });

    // Respect external pause/resume commands (e.g. from tray)
    bus.on('power:stateChange', ({ state }) => {
      if (this.state !== state) {
        this.state = state;
        console.log(`[PowerManager] State opdateret eksternt → ${state}`);
      }
    });

    // System suspend/resume
    powerMonitor.on('suspend', () => {
      if (this.state === 'active' || this.state === 'field-notes') {
        this.transitionTo('sleeping', 'System suspenderet');
      }
    });

    powerMonitor.on('resume', () => {
      if (this.state === 'sleeping') {
        const onAC = !powerMonitor.isOnBatteryPower();
        this.transitionTo(onAC ? 'active' : 'field-notes', 'System genoptaget');
      }
    });
  }

  private transitionTo(state: GracePowerState, reason: string): void {
    if (this.state === state) return;
    const prev = this.state;
    this.state = state;

    console.log(`[PowerManager] ${prev} → ${state}: ${reason}`);
    bus.emit('power:stateChange', { state, reason });
  }

  private onACReconnect(): void {
    const noteCount = this.fieldNotes.length;
    const sessionStart = this.sessionStart;

    this.transitionTo('active', 'AC genoprettet — vågner op');

    if (noteCount > 0) {
      console.log(`[PowerManager] ${noteCount} noter klar til opsummering`);
      // Signal to GraceCore that field notes are ready for LLM summarisation
      setTimeout(() => {
        bus.emit('power:fieldNotesSummaryReady', { noteCount, sessionStart });
      }, 3000); // Give LLM 3s to load before requesting summary
    }
  }
}
