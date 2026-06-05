// Grace Vignette Window(s)
//
// One fullscreen, transparent, always-on-top, click-through window PER connected
// display. Each window:
//   1. Draws a coloured inset glow around its screen edges reflecting Grace state.
//   2. Renders animated SVG focus boxes when Grace annotates screen elements.
//
// 100% click-through -- never blocks input.
//
// ── Coordinate contract for focus boxes ──────────────────────────────────────
// `overlay:focusBox` carries ABSOLUTE virtual-desktop coordinates in DIPs
// (device-independent pixels), i.e. the same space as Electron `screen` bounds.
// take_screenshot/analyze_screen produce coordinates in this space (they capture
// with a DPI-UNAWARE PowerShell process, whose pixels equal Windows logical/DIP
// units, so capture pixels line up 1:1 with Electron bounds and with these
// click-through windows' CSS pixels — no per-monitor scale math required).
//
// This class routes each box to the window(s) it overlaps, translating the
// coordinates into that display's local (window-relative) space before sending.

import { BrowserWindow, screen } from 'electron';
import type { Display } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { bus } from '@grace/core';

interface FocusBoxData {
  x: number; y: number; w: number; h: number;
  label?: string; duration?: number; pulse?: boolean;
}

export class VignetteWindow {
  // displayId -> window. One window per connected display.
  private windows = new Map<number, BrowserWindow>();
  private lastState = 'idle';

  constructor() {
    this.createAll();
    this.listenDisplayChanges();
    this.listenBus();
  }

  // ── Window lifecycle ──────────────────────────────────────────────────────

  private createAll(): void {
    for (const d of screen.getAllDisplays()) this.createForDisplay(d);
    console.log(`[Vignette] Spawned ${this.windows.size} vignette window(s), one per display.`);
  }

  private createForDisplay(display: Display): void {
    if (this.windows.has(display.id)) return;
    const { x, y, width, height } = display.bounds;

    const win = new BrowserWindow({
      x, y, width, height,
      transparent: true,
      backgroundColor: '#00000000', // fully transparent RGBA — avoids black fallback on Windows
      frame: false,
      show: false,                  // wait for ready-to-show, then showInactive (Windows first-paint reliability)
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      resizable: false,
      type: 'toolbar',              // more reliable for transparent overlays on Windows
      webPreferences: {
        preload: path.join(__dirname, 'vignettePreload.cjs'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    win.setIgnoreMouseEvents(true, { forward: true });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    win.once('ready-to-show', () => {
      win.showInactive();                       // show without stealing focus
      win.setAlwaysOnTop(true, 'screen-saver', 1); // raise AFTER it's shown
      // Re-sync the current state to the freshly shown window.
      win.webContents.send('vignette:state', this.lastState);
      console.log(`[Vignette] display ${display.id} ready @ (${display.bounds.x},${display.bounds.y}) ${display.bounds.width}x${display.bounds.height}`);
    });

    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error(`[Vignette] display ${display.id} failed to load: ${code} ${desc}`);
    });

    win.loadFile(path.join(__dirname, '../renderer/vignette.html'));
    this.windows.set(display.id, win);
  }

  private destroyForDisplay(displayId: number): void {
    const win = this.windows.get(displayId);
    if (win && !win.isDestroyed()) win.destroy();
    this.windows.delete(displayId);
    console.log(`[Vignette] Removed window for display ${displayId}.`);
  }

  private listenDisplayChanges(): void {
    screen.on('display-added', (_e, display) => {
      console.log(`[Vignette] display-added ${display.id}`);
      this.createForDisplay(display);
    });
    screen.on('display-removed', (_e, display) => {
      console.log(`[Vignette] display-removed ${display.id}`);
      this.destroyForDisplay(display.id);
    });
    // Resolution / position change: resize the matching window to the new bounds.
    screen.on('display-metrics-changed', (_e, display) => {
      const win = this.windows.get(display.id);
      if (win && !win.isDestroyed()) {
        const { x, y, width, height } = display.bounds;
        win.setBounds({ x, y, width, height });
      } else {
        this.createForDisplay(display);
      }
    });
  }

  // ── Broadcast / routing ───────────────────────────────────────────────────

  /** Send a channel+payload to EVERY vignette window. */
  private broadcast(channel: string, data: unknown): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.webContents.send(channel, data);
    }
  }

  private setState(state: string): void {
    this.lastState = state;
    this.broadcast('vignette:state', state);
  }

  /**
   * Route a focus box (absolute virtual-desktop DIP coords) to the window(s)
   * whose display it overlaps, translating to display-local coordinates.
   */
  private routeFocusBox(box: FocusBoxData): void {
    let routed = 0;
    for (const display of screen.getAllDisplays()) {
      const b = display.bounds;
      const intersects =
        box.x < b.x + b.width && box.x + box.w > b.x &&
        box.y < b.y + b.height && box.y + box.h > b.y;
      if (!intersects) continue;

      const win = this.windows.get(display.id);
      if (!win || win.isDestroyed()) continue;

      win.webContents.send('vignette:focusBox', {
        ...box,
        x: box.x - b.x,
        y: box.y - b.y,
      });
      routed++;
    }
    if (routed === 0) {
      console.warn(`[Vignette] focusBox (${box.x},${box.y} ${box.w}x${box.h}) fell outside every display — ignored.`);
    }
  }

  // ── Bus wiring ────────────────────────────────────────────────────────────

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
      this.setState(stateMap[type] ?? 'idle');
    });

    // stt:listening fires when Whisper first becomes ready.
    bus.on('stt:listening', ({ active }) => {
      this.setState(active ? 'listening' : 'idle');
    });

    bus.on('system:modeChange', ({ mode }) => {
      if (mode === 'discreet') this.setState('discreet');
      else if (mode === 'normal') this.setState('listening');
    });

    bus.on('power:stateChange', ({ state }) => {
      if (state === 'paused' || state === 'sleeping') this.setState('idle');
      else if (state === 'field-notes') this.setState('field-notes');
      else if (state === 'active') this.setState('listening');
    });

    // Focus boxes — routed to the correct display.
    bus.on('overlay:focusBox', (data) => this.routeFocusBox(data as FocusBoxData));
    bus.on('overlay:clearFocusBoxes', () => this.broadcast('vignette:clearFocusBoxes', {}));
  }

  destroy(): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.destroy();
    }
    this.windows.clear();
  }
}
