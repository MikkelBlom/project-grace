// ─────────────────────────────────────────────
// DebugWindow — live state inspector for Grace
//
// Two data sources:
//   1. interceptConsole() — captures every console.log/warn/error
//      from ALL packages (WhisperSTT, Core, OllamaLLM, …).
//      Call this from main.ts BEFORE creating other services.
//   2. Bus event bridge — captures structured state changes
//      (VAD, transcript, LLM response, mode, power, errors).
//
// Toggle: Ctrl+Shift+L
// ─────────────────────────────────────────────

import { BrowserWindow, ipcMain, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { bus } from '@grace/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type LogLevel = 'log' | 'error' | 'warn';

export class DebugWindow {
  private win:       BrowserWindow | null = null;
  private ready      = false;
  // Buffer messages that arrive before renderer is loaded
  private preloadBuf: Array<{ type: string; [k: string]: unknown }> = [];

  constructor() {
    this.createWindow();
    this.setupBridge();
  }

  // ── Window creation ─────────────────────────

  private createWindow(): void {
    const display = screen.getPrimaryDisplay();
    const { x, y } = display.workArea;

    this.win = new BrowserWindow({
      width:  420,
      height: 620,
      x: x + 20,
      y: y + 20,
      frame:           false,
      alwaysOnTop:     true,
      resizable:       true,
      skipTaskbar:     false,
      backgroundColor: '#0d1117',
      webPreferences: {
        preload:          path.join(__dirname, 'debugPreload.cjs'),
        sandbox:          false,
        contextIsolation: true,
        nodeIntegration:  false,
      },
    });

    // 'screen-saver' is the highest always-on-top level on Windows —
    // same as the main overlay. Without it the window sinks behind other apps.
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true);
    this.win.loadFile(path.join(__dirname, '../renderer/debug.html'));

    // Flush buffered messages once the renderer is ready
    this.win.webContents.once('did-finish-load', () => {
      this.ready = true;
      for (const msg of this.preloadBuf) {
        this._ipc(msg);
      }
      this.preloadBuf = [];
    });

    ipcMain.on('debug:close', () => this.hide());
  }

  // ── Console interception ────────────────────
  // Wraps console.log / warn / error so every log call also goes to
  // the debug overlay. Call this BEFORE constructing other services.

  interceptConsole(): void {
    const self = this;
    const origLog   = console.log.bind(console);
    const origWarn  = console.warn.bind(console);
    const origError = console.error.bind(console);

    function fmt(...args: unknown[]): string {
      return args.map(a =>
        typeof a === 'string' ? a
        : (a instanceof Error) ? a.message
        : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()
      ).join(' ');
    }

    console.log = (...args: unknown[]) => {
      origLog(...args);
      self._send({ type: 'log', level: 'log',   msg: fmt(...args) });
    };
    console.warn = (...args: unknown[]) => {
      origWarn(...args);
      self._send({ type: 'log', level: 'warn',  msg: fmt(...args) });
    };
    console.error = (...args: unknown[]) => {
      origError(...args);
      self._send({ type: 'log', level: 'error', msg: fmt(...args) });
    };
  }

  // ── Bus → Debug bridge ──────────────────────

  private setupBridge(): void {
    bus.on('stt:listening', () =>
      this._send({ type: 'state', state: 'listening' }));

    bus.on('stt:vad', ({ hasVoice }) =>
      this._send({ type: 'vad', hasVoice }));

    bus.on('stt:heard', ({ text, confidence }) =>
      this._send({ type: 'heard', text, confidence }));

    bus.on('llm:thinking', ({ text }) =>
      this._send({ type: 'state', state: 'thinking',
        preview: String(text ?? '').slice(0, 80) }));

    bus.on('llm:response', ({ text }) =>
      this._send({ type: 'response', text: String(text ?? '').slice(0, 400) }));

    bus.on('tts:speaking', () =>
      this._send({ type: 'state', state: 'speaking' }));

    bus.on('tts:done', () =>
      this._send({ type: 'state', state: 'listening' }));

    bus.on('system:modeChange', ({ mode, reason }) =>
      this._send({ type: 'mode', mode, reason }));

    bus.on('power:stateChange', ({ state, reason }) =>
      this._send({ type: 'power', state, reason }));

    bus.on('system:error', ({ source, error, recoverable }) =>
      this._send({ type: 'error', source, error, recoverable }));
  }

  // ── IPC helpers ─────────────────────────────

  private _send(data: { type: string; [k: string]: unknown }): void {
    if (!this.ready) {
      this.preloadBuf.push(data);
      return;
    }
    this._ipc(data);
  }

  private _ipc(data: object): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('debug:event', data);
    }
  }

  // ── Public API ───────────────────────────────

  show():   void { this.win?.show(); }
  hide():   void { this.win?.hide(); }

  toggle(): void {
    if (!this.win) return;
    this.win.isVisible() ? this.win.hide() : this.win.show();
  }

  destroy(): void {
    ipcMain.removeAllListeners('debug:close');
    this.win?.destroy();
    this.win = null;
  }
}
