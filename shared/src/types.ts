// ─────────────────────────────────────────────
// Core domain types for Project Grace
// ─────────────────────────────────────────────

export type GraceMode =
  | 'normal'
  | 'discreet'     // Zero logging, VAD-only
  | 'brainstorm'   // VAD-lock, long-form listening
  | 'meeting'      // WASAPI loopback + transcript
  | 'autopilot'    // Autonomous background agent
  | 'image'        // Flux.1 exclusive VRAM mode
  | 'gaming'       // Low-latency overlay mode
  | 'field-notes'; // Battery mode: VAD + lightweight STT, no LLM/TTS

/**
 * Power state — how aggressively Grace uses resources.
 *
 * - active:       Full pipeline (STT + LLM + TTS). Requires AC power.
 * - field-notes:  Battery mode. VAD + Whisper small only. No LLM, no TTS.
 *                 Notes buffered, summarised on AC reconnect.
 * - paused:       All services suspended. Zero CPU/GPU. Process kept alive.
 * - sleeping:     LLM unloaded, VRAM freed. Only tray icon remains.
 */
export type GracePowerState = 'active' | 'field-notes' | 'paused' | 'sleeping';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ConversationTurn {
  role: 'user' | 'grace';
  content: string;
  timestamp: Date;
  sessionId: string;
  /** Never stored in discreet mode */
  persist: boolean;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  callId: string;
}

export interface ToolResult {
  callId: string;
  result: unknown;
  error?: string;
  duration_ms?: number;
}

export interface LLMResponse {
  text: string;
  toolCalls?: ToolCall[];
  sessionId: string;
  model: string;
  tokens?: number;
  /** Provider already streamed the speech (emitted tts:speaking); GraceCore must not re-speak. */
  spoken?: boolean;
}

export interface GraceConfig {
  llm: {
    provider: 'mock' | 'ollama' | 'vllm';
    model: string;
    baseUrl?: string;
    contextWindow?: number;
  };
  stt: {
    provider: 'mock' | 'whisper';
    model?: string;
    language?: string;
    device?: 'cpu' | 'cuda';
  };
  tts: {
    provider: 'mock' | 'kokoro';
    voice?: string;
    speed?: number;
  };
  overlay: {
    position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
    opacity: number;
    alwaysOnTop: boolean;
    /** 0 = primary, 1 = second display, -1 = follow active app */
    displayIndex: number;
  };
  privacy: {
    discreteModeApps: string[];
    discreteModeBrowser: boolean;
    discreteModeSchedule: string[];
  };
  power: {
    /** Pause Grace automatically when a fullscreen game is detected */
    autoPauseOnGame: boolean;
    /** Resume full pipeline automatically when AC is reconnected */
    autoResumeOnAC: boolean;
    /** Whisper model to use in field-notes (battery) mode */
    fieldNotesWhisperModel: 'tiny' | 'base' | 'small';
  };
  sandbox: {
    dockerImage: string;
    maxIterations: number;
  };
}

export const defaultConfig: GraceConfig = {
  llm: { provider: 'mock', model: 'mock-llm' },
  stt: { provider: 'mock' },
  tts: { provider: 'mock' },
  overlay: {
    position: 'bottom-right',
    opacity: 0.92,
    alwaysOnTop: true,
    displayIndex: -1,  // -1 = primary display; 0,1,2... = specific monitor
  },
  privacy: {
    discreteModeApps: [],
    discreteModeBrowser: true,
    discreteModeSchedule: [],
  },
  power: {
    autoPauseOnGame: true,
    autoResumeOnAC: true,
    fieldNotesWhisperModel: 'small',
  },
  sandbox: {
    dockerImage: 'node:20-alpine',
    maxIterations: 5,
  },
};
