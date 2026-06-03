// ─────────────────────────────────────────────
// Grace System Tray
//
// Provides a notification-area icon with a quick-menu for
// controlling Grace's power state without opening any window.
//
// States:
//   Active   — full pipeline running
//   Paused   — all services suspended, zero CPU/GPU
//   Sleeping — LLM unloaded, VRAM freed
//   Quit     — app.quit()
//
// Global shortcut: Ctrl+Shift+P toggles Active ↔ Paused
// ─────────────────────────────────────────────

import { Tray, Menu, nativeImage, app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { bus } from '@grace/core';
import type { GracePowerState } from '@grace/shared';

// ── Tray icons (PNG, 16×16 or 22×22) ──────────
// We generate minimal coloured circles via nativeImage so the app
// works out-of-the-box without an asset pipeline.  Replace with
// real icon files later by pointing these paths at actual .png files.

function circleIcon(hex: string, size = 16): Electron.NativeImage {
  // 1×1 PNG that Electron will scale — good enough for tray
  // Real implementation: load from assets/tray-*.png
  const img = nativeImage.createEmpty();
  // Fallback: return empty and let the OS show a default
  return img;
}

// ─────────────────────────────────────────────

export class GraceTray {
  private tray: Tray | null = null;
  private powerState: GracePowerState = 'active';
  private mainWindow: BrowserWindow | null = null;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
    this.create();
    this.listenBus();
  }

  // ── Public ──────────────────────────────────

  getPowerState(): GracePowerState {
    return this.powerState;
  }

  togglePause(): void {
    if (this.powerState === 'active') {
      this.applyState('paused', 'Manual toggle (Ctrl+Shift+P)');
    } else if (this.powerState === 'paused') {
      this.applyState('active', 'Manual toggle (Ctrl+Shift+P)');
    }
    // field-notes and sleeping are not toggled this way
  }

  destroy(): void {
    this.tray?.destroy();
  }

  // ── Private ─────────────────────────────────

  private create(): void {
    // Minimal tray icon — replace with real asset later
    const iconPath = path.join(__dirname, '../../assets/tray-active.png');
    let icon: Electron.NativeImage;
    try {
      icon = nativeImage.createFromPath(iconPath);
    } catch {
      icon = nativeImage.createEmpty();
    }

    this.tray = new Tray(icon);
    this.tray.setToolTip('Grace — aktiv');
    this.updateMenu();
  }

  private updateMenu(): void {
    if (!this.tray) return;

    const stateLabel: Record<GracePowerState, string> = {
      'active':      '▶  Aktiv (fuld pipeline)',
      'field-notes': '📓 Field Notes (batteri)',
      'paused':      '⏸  Pause (nul CPU/GPU)',
      'sleeping':    '💤 Slumre (VRAM frigivet)',
    };

    const menu = Menu.buildFromTemplate([
      {
        label: `Grace — ${stateLabel[this.powerState]}`,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: '▶  Aktiv',
        type: 'radio',
        checked: this.powerState === 'active',
        click: () => this.applyState('active', 'Tray menu'),
      },
      {
        label: '⏸  Pause  (Ctrl+Shift+P)',
        type: 'radio',
        checked: this.powerState === 'paused',
        click: () => this.applyState('paused', 'Tray menu'),
      },
      {
        label: '💤 Slumre  (frigiver VRAM)',
        type: 'radio',
        checked: this.powerState === 'sleeping',
        click: () => this.applyState('sleeping', 'Tray menu'),
      },
      { type: 'separator' },
      {
        label: '🖥  Vis overlay',
        click: () => this.mainWindow?.show(),
      },
      {
        label: '⛔ Luk Grace',
        click: () => app.quit(),
      },
    ]);

    this.tray.setContextMenu(menu);

    // Update tooltip to reflect current state
    const tooltips: Record<GracePowerState, string> = {
      'active':      'Grace — aktiv',
      'field-notes': 'Grace — field notes (batteri)',
      'paused':      'Grace — på pause',
      'sleeping':    'Grace — slumrer',
    };
    this.tray.setToolTip(tooltips[this.powerState]);
  }

  private applyState(state: GracePowerState, reason: string): void {
    if (this.powerState === state) return;
    const prev = this.powerState;
    this.powerState = state;
    this.updateMenu();

    console.log(`[Tray] Power state: ${prev} → ${state} (${reason})`);

    // Broadcast to all services
    bus.emit('power:stateChange', { state, reason });

    // Reflect in overlay
    const msgs: Record<GracePowerState, { text: string; level: 'info' | 'warning' | 'error' }> = {
      'active':      { text: '▶ Grace er aktiv igen',           level: 'info' },
      'field-notes': { text: '📓 Field Notes Mode — lytter passivt', level: 'info' },
      'paused':      { text: '⏸ Grace sat på pause',             level: 'warning' },
      'sleeping':    { text: '💤 Grace slumrer — VRAM frigivet',  level: 'warning' },
    };

    bus.emit('overlay:notification', { ...msgs[state], duration: 3500 });

    // Hide overlay entirely when paused/sleeping
    if (state === 'paused' || state === 'sleeping') {
      this.mainWindow?.hide();
    } else {
      this.mainWindow?.show();
    }
  }

  private listenBus(): void {
    // Reflect external power state changes (e.g. from PowerManager)
    bus.on('power:stateChange', ({ state }) => {
      if (this.powerState !== state) {
        this.powerState = state;
        this.updateMenu();
      }
    });
  }
}
