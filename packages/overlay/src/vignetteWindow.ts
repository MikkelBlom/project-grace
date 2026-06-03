// Grace Vignette Window
//
// Fullscreen, transparent, always-on-top window that:
//   1. Draws a coloured inset glow around screen edges reflecting Grace state.
//   2. Renders animated SVG focus boxes when Grace annotates screen elements.
//
// 100% click-through -- never blocks input.

import { BrowserWindow, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { bus } from '@grace/core';

export class VignetteWindow {
  private win: BrowserWindow | null = null;

  constructor() {
    this.create();
    this.listenBus();
    this.listenIPC();
  }

  private create(): void {
    const { bounds } = screen.getPrimaryDisplay();

    this.win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      resizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'vignettePreload.cjs'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.win.setAlwaysOnTop(true, 'screen-saver', 1);
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.loadFile(path.join(__dirname, '../renderer/vignette.html'));
  }

  private send(channel: string, data: unknown): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, data);
    }
  }

  private listenBus(): void {
    // Primary state driver: GraceCore emits overlay:show for think/speak/listen transitions
    bus.on('overlay:show', ({ type }) => {
      const stateMap: Record<string, string> = {
        listening:     'listening',
        thinking:      'thinking',
        speaking:      'speaking',
        idle:          'idle',
        'field-notes': 'field-notes',
        paused:        'idle',
        notification:  'listening',
      };
      this.send('vignette:state', stateMap[type] ?? 'idle');
    });

    // stt:listening fires when Whisper first becomes ready.
    // GraceCore does NOT emit overlay:show for this, so we handle it directly.
    bus.on('stt:listening', ({ active }) => {
      this.send('vignette:state', active ? 'listening' : 'idle');
    });

    bus.on('system:modeChange', ({ mode }) => {
      if (mode === 'discreet') this.send('vignette:state', 'discreet');
      else if (mode === 'normal') this.send('vignette:state', 'listening');
    });

    bus.on('power:stateChange', ({ state }) => {
      if (state === 'paused' || state === 'sleeping') {
        this.send('vignette:state', 'idle');
      } else if (state === 'field-notes') {
        this.send('vignette:state', 'field-notes');
      } else if (state === 'active') {
        this.send('vignette:state', 'listening');
      }
    });

    // Focus boxes
    bus.on('overlay:focusBox', (data) => {
      this.send('vignette:focusBox', data);
    });

    bus.on('overlay:clearFocusBoxes', () => {
      this.send('vignette:clearFocusBoxes', {});
    });
  }

  private listenIPC(): void {
    // Vignette is output-only -- no inbound IPC needed yet
  }

  destroy(): void {
    this.win?.destroy();
  }
}
