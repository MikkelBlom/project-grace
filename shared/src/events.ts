// ─────────────────────────────────────────────
// Typed event definitions for the Grace EventBus
// Every cross-service message is declared here.
// ─────────────────────────────────────────────

import type { GraceMode, GracePowerState, LLMResponse, ToolCall, ToolResult } from './types.js';

export interface GraceEvents {
  // ── STT ───────────────────────────────────
  'stt:heard': { text: string; confidence: number; sessionId: string };
  'stt:listening': { active: boolean };
  'stt:vad': { hasVoice: boolean };
  'stt:pause': Record<string, never>;
  'stt:resume': Record<string, never>;

  // ── LLM ───────────────────────────────────
  /** text = the user's raw utterance — passed through so LLM handlers can do contextual matching */
  'llm:thinking': { sessionId: string; text?: string; history?: Array<{ role: string; content: string }> };
  'llm:response': LLMResponse;
  'llm:chunk': { text: string; sessionId: string };

  // ── TTS ───────────────────────────────────
  'tts:speaking': { text: string; sessionId: string };
  'tts:done': { sessionId: string };

  // ── Tools ─────────────────────────────────
  'tool:execute': ToolCall;
  'tool:result': ToolResult;

  // ── System ────────────────────────────────
  'system:modeChange': { mode: GraceMode; reason?: string };
  'system:contextUpdate': { activeApp: string; windowTitle: string; url?: string; isFullscreen?: boolean };
  'system:error': { source: string; error: string; recoverable: boolean };
  'system:proactiveIntent': { text: string; priority: 'low' | 'medium' | 'high' };

  // ── Power ─────────────────────────────────
  /** Power state changed (active / field-notes / paused / sleeping) */
  'power:stateChange': { state: GracePowerState; reason: string };
  /** AC power plugged or unplugged */
  'power:acChange': { onAC: boolean };
  /** Field notes accumulated while on battery — ready for summarisation */
  'power:fieldNotesSummaryReady': { noteCount: number; sessionStart: Date };

  // ── Overlay ───────────────────────────────
  'overlay:show': {
    type: 'listening' | 'thinking' | 'speaking' | 'notification' | 'idle' | 'field-notes' | 'paused';
    data?: { text?: string; level?: 'info' | 'warning' | 'error'; duration?: number };
  };
  'overlay:notification': {
    text: string;
    level: 'info' | 'warning' | 'error';
    duration?: number;
  };
  /**
   * Annotate a screen element with an animated focus box.
   * Coordinates are in screen pixels (from LLaVA bounding box output).
   */
  'overlay:focusBox': {
    x: number;
    y: number;
    w: number;
    h: number;
    label?: string;
    /** Auto-dismiss after this many ms. Default 4000. */
    duration?: number;
    /** Keep pulsing while Grace is actively talking about this element */
    pulse?: boolean;
  };
  /** Remove all active focus boxes */
  'overlay:clearFocusBoxes': Record<string, never>;

  // ── Sandbox ───────────────────────────────
  'sandbox:run': { projectPath: string; code: string; testCommand: string; iterationId: string };
  'sandbox:result': { iterationId: string; output: string; error?: string; exitCode: number };
}
