// ─────────────────────────────────────────────
// Electron preload — exposes safe IPC bridge to renderer
// contextBridge prevents renderer from accessing Node directly
// ─────────────────────────────────────────────

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('grace', {
  /** Listen for state updates from the main process */
  onStateUpdate: (callback: (data: Record<string, unknown>) => void) => {
    ipcRenderer.on('grace:stateUpdate', (_, data) => callback(data));
  },
  /** Tell main to resize the overlay window */
  resize: (width: number, height: number) => {
    ipcRenderer.send('overlay:resize', { width, height });
  },
  /** Toggle click-through (passive when true) */
  setClickThrough: (enabled: boolean) => {
    ipcRenderer.send('overlay:setClickThrough', enabled);
  },
  /** Request a mode change from the renderer (e.g. button click) */
  requestMode: (mode: string) => {
    ipcRenderer.send('overlay:requestMode', mode);
  },
});
