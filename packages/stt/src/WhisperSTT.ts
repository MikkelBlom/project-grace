// WhisperSTT -- Phase 1 real implementation
//
// Spawns grace_whisper_server.py directly via Windows Python.
// The Python process streams 16kHz PCM from the microphone
// and returns newline-delimited JSON:
//   { "type": "transcript", "text": "...", "confidence": 0.95 }
//   { "type": "vad", "has_voice": true }
//   { "type": "ready" }
//
// Env config:
//   GRACE_WHISPER_MODEL=large-v3     (tiny|base|small|medium|large-v3)
//   GRACE_WHISPER_DEVICE=cuda        (cuda|cpu)
//   GRACE_WHISPER_LANG=da            (language hint, or 'auto')
//   GRACE_PYTHON_CMD=py              (python command)

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { bus } from '@grace/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODEL      = process.env.GRACE_WHISPER_MODEL  ?? 'large-v3';
const DEVICE     = process.env.GRACE_WHISPER_DEVICE ?? 'cuda';
const LANG       = process.env.GRACE_WHISPER_LANG   ?? 'da';
// 'faster-whisper' (CUDA) or 'openvino' (Arc iGPU). OV model/device come from
// GRACE_OV_MODEL / GRACE_OV_DEVICE env, read directly by the Python server.
const BACKEND    = process.env.GRACE_STT_BACKEND    ?? 'faster-whisper';
const PYTHON_CMD = process.env.GRACE_PYTHON_CMD     ?? 'py';
// Optional version flag for the Windows py launcher (e.g. '-3.12').
// Set GRACE_PYTHON_VER='' to disable if using python3 directly.
const PYTHON_VER = process.env.GRACE_PYTHON_VER ?? '-3.12';

// Path: compiled to packages/stt/dist/ — go up 3 levels to reach grace/ root
const SERVER_SCRIPT = path.resolve(__dirname, '../../../grace_whisper_server.py');

export class WhisperSTT {
  private process: ChildProcess | null = null;
  private running = false;
  private lineBuffer = '';
  private sessionCounter = 0;

  constructor() {
    bus.on('stt:pause', () => this.pause());
    bus.on('stt:resume', () => this.resume());
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    console.log('[WhisperSTT] Starting Python server (Windows)...');
    console.log(`[WhisperSTT]   Script: ${SERVER_SCRIPT}`);
    console.log(`[WhisperSTT]   Backend: ${BACKEND}`);
    console.log(`[WhisperSTT]   Model:  ${MODEL}`);
    console.log(`[WhisperSTT]   Device: ${DEVICE}`);
    console.log(`[WhisperSTT]   Lang:   ${LANG}`);

    this.process = spawn(PYTHON_CMD, [
      ...(PYTHON_VER ? [PYTHON_VER] : []),
      SERVER_SCRIPT,
      '--model',   MODEL,
      '--device',  DEVICE,
      '--lang',    LANG,
      '--backend', BACKEND,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUTF8: '1',           // Force Python stdout/stderr to UTF-8
        PYTHONIOENCODING: 'utf-8', // Belt + braces for older Python builds
      },
    });

    this.process.stdout?.setEncoding('utf-8');
    this.process.stderr?.setEncoding('utf-8');

    // Parse newline-delimited JSON from Python
    this.process.stdout?.on('data', (chunk: string) => {
      this.lineBuffer += chunk;
      const lines = this.lineBuffer.split('\n');
      this.lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as {
            type: string;
            text?: string;
            confidence?: number;
            language?: string;
            has_voice?: boolean;
            error?: string;
          };
          this.handleMessage(msg);
        } catch {
          // Startup messages / non-JSON output -- ignore
        }
      }
    });

    this.process.stderr?.on('data', (chunk: string) => {
      // Show startup / diagnostic messages — filter repetitive noise
      const filtered = chunk
        .split('\n')
        .filter(l => {
          const t = l.trim();
          if (!t) return false;
          if (t.includes('UserWarning'))       return false;
          if (t.includes('FutureWarning'))     return false;
          if (t.includes('DeprecationWarning')) return false;
          // Intel oneDNN OpenCL probe noise from the OpenVINO iGPU backend (harmless)
          if (t.includes('onednn_verbose') || t.includes('CL_INVALID_OPERATION')) return false;
          // VAD probability lines ([VAD] prob=0.00 |...|) — shown every ~2s,
          // visible in the debug overlay instead (Ctrl+Shift+L)
          if (/^\[VAD\] prob=/.test(t))        return false;
          return true;
        })
        .join('\n');
      if (filtered) console.log(`[WhisperSTT:py] ${filtered}`);
    });

    this.process.on('error', (err) => {
      console.error('[WhisperSTT] Failed to spawn Python process:', err.message);
      bus.emit('system:error', {
        source: 'WhisperSTT',
        error: `Python spawn failed: ${err.message}`,
        recoverable: false,
      });
      this.running = false;
    });

    this.process.on('exit', (code, signal) => {
      if (signal === 'SIGTERM') return;
      console.log(`[WhisperSTT] Python process exited (code=${code})`);
      this.running = false;
      bus.emit('stt:listening', { active: false });

      if (code !== 0) {
        bus.emit('system:error', {
          source: 'WhisperSTT',
          error: `Process exited with code ${code}`,
          recoverable: true,
        });
        console.log('[WhisperSTT] Restarting in 5s...');
        setTimeout(() => { if (!this.running) this.start(); }, 5000);
      }
    });
  }

  stop(): void {
    this.running = false;
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    bus.emit('stt:listening', { active: false });
    console.log('[WhisperSTT] Stopped.');
  }

  pause(): void {
    if (this.process?.stdin && this.running) {
      console.log('[WhisperSTT] Pausing microphone (TTS is speaking)');
      this.process.stdin.write(JSON.stringify({ command: 'pause' }) + '\n');
    }
  }

  resume(): void {
    if (this.process?.stdin && this.running) {
      console.log('[WhisperSTT] Resuming microphone (TTS finished)');
      this.process.stdin.write(JSON.stringify({ command: 'resume' }) + '\n');
    }
  }

  private handleMessage(msg: {
    type: string;
    text?: string;
    confidence?: number;
    language?: string;
    has_voice?: boolean;
    error?: string;
  }): void {
    switch (msg.type) {
      case 'ready':
        console.log('[WhisperSTT] Model loaded -- lytter aktivt');
        bus.emit('stt:listening', { active: true });
        bus.emit('overlay:notification', {
          text: `Whisper ${MODEL} klar -- lytter`,
          level: 'info', duration: 3000,
        });
        break;

      case 'vad':
        if (msg.has_voice) {
          process.stdout.write('\r[VAD] Stemme detekteret...                    ');
        } else {
          process.stdout.write('\r[VAD] Stille                                  ');
        }
        bus.emit('stt:vad', { hasVoice: msg.has_voice ?? false });
        break;

      case 'transcript': {
        if (!msg.text?.trim()) break;
        this.sessionCounter++;
        const sessionId = `stt-${Date.now()}-${this.sessionCounter}`;
        const text = msg.text.trim();
        console.log(`\n[WhisperSTT] Hoerte: "${text}" (conf=${(msg.confidence ?? 1).toFixed(2)}, lang=${msg.language ?? '?'})`);
        // Show in overlay so user can verify what was heard
        const preview = text.length > 50 ? text.slice(0, 47) + '...' : text;
        bus.emit('overlay:notification', {
          text: `Dig: "${preview}"`,
          level: 'info', duration: 4000,
        });
        bus.emit('stt:heard', {
          text,
          confidence: msg.confidence ?? 1.0,
          sessionId,
        });
        break;
      }

      case 'error':
        console.error(`[WhisperSTT] Python error: ${msg.error}`);
        bus.emit('system:error', {
          source: 'WhisperSTT',
          error: msg.error ?? 'Unknown Python error',
          recoverable: true,
        });
        break;
    }
  }
}
