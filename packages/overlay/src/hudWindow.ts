// ─────────────────────────────────────────────────────────────────────────────
// HUD window — OPT-IN companion overlay for passive widgets (live transcript, focus
// countdown, notification toasts). Enabled only when GRACE_HUD is set, so the working
// vignette is completely untouched by default.
//
// Architecture (per the 2026 overlay research): passive/animated content lives in its
// OWN transparent, always-on-top, click-through window — it never captures the mouse,
// so there is zero click-through-toggling risk and it can't break the vignette. Anything
// INTERACTIVE (a history panel, timer controls) should be a further dedicated window; this
// class deliberately stays passive.
//
// It forwards a curated set of bus events to the renderer over IPC:
//   stt:heard        → hud:transcript (role 'you')
//   tts:speaking     → hud:transcript (role 'grace')
//   overlay:timer    → hud:timer      (focus countdown)
//   overlay:notification → hud:toast
//   nativeTheme      → hud:theme
// ─────────────────────────────────────────────────────────────────────────────

import { BrowserWindow, screen, nativeTheme } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { bus } from '@grace/core';

export class HudWindow {
  private win: BrowserWindow | null = null;

  constructor() {
    this.create();
    this.listenBus();
  }

  private create(): void {
    const primary = screen.getPrimaryDisplay();
    const { x, y, width, height } = primary.bounds;

    const win = new BrowserWindow({
      x, y, width, height,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      resizable: false,
      type: 'toolbar',
      webPreferences: {
        preload: path.join(__dirname, 'hudPreload.cjs'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Fully click-through and passive — the whole point is that it never captures the mouse.
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    win.once('ready-to-show', () => {
      win.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver', 1);
      this.send('hud:theme', { dark: nativeTheme.shouldUseDarkColors });
      console.log('[HUD] ready (opt-in HUD overlay active)');
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => console.error(`[HUD] failed to load: ${code} ${desc}`));

    win.loadFile(path.join(__dirname, '../renderer/hud.html'));
    this.win = win;

    nativeTheme.on('updated', () => this.send('hud:theme', { dark: nativeTheme.shouldUseDarkColors }));
  }

  private send(channel: string, data: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, data);
  }

  private listenBus(): void {
    bus.on('stt:heard', ({ text }) => { if (text?.trim()) this.send('hud:transcript', { role: 'you', text }); });
    bus.on('tts:speaking', ({ text }) => { if (text?.trim()) this.send('hud:transcript', { role: 'grace', text }); });
    bus.on('overlay:timer', (d) => this.send('hud:timer', d));
    bus.on('overlay:notification', (d) => this.send('hud:toast', d));
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
