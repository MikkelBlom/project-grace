// ─────────────────────────────────────────────
// Vignette window preload
// Exposes IPC bridge to the renderer
// ─────────────────────────────────────────────

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('vignette', {
  onState:          (cb: (state: string) => void)      => ipcRenderer.on('vignette:state',          (_, d) => cb(d)),
  onFocusBox:       (cb: (data: unknown) => void)      => ipcRenderer.on('vignette:focusBox',        (_, d) => cb(d)),
  onClearFocusBoxes:(cb: () => void)                   => ipcRenderer.on('vignette:clearFocusBoxes', () => cb()),
});
