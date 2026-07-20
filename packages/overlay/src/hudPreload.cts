// ─────────────────────────────────────────────
// HUD window preload — exposes the HUD IPC channels to the renderer.
// Opt-in companion to the vignette (see hudWindow.ts). Passive widgets only.
// ─────────────────────────────────────────────

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('hud', {
  onTranscript: (cb: (d: { role: string; text: string }) => void) => ipcRenderer.on('hud:transcript', (_, d) => cb(d)),
  onTimer:      (cb: (d: { active: boolean; endsAt: number; task: string }) => void) => ipcRenderer.on('hud:timer', (_, d) => cb(d)),
  onToast:      (cb: (d: { text: string; level: string; duration?: number }) => void) => ipcRenderer.on('hud:toast', (_, d) => cb(d)),
  onTheme:      (cb: (d: { dark: boolean }) => void) => ipcRenderer.on('hud:theme', (_, d) => cb(d)),
});
