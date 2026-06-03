// ─────────────────────────────────────────────
// Debug window preload — exposes graceDebug IPC bridge
// ─────────────────────────────────────────────

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('graceDebug', {
  /** Receive events from the main process */
  onEvent: (callback: (event: Record<string, unknown>) => void) => {
    ipcRenderer.on('debug:event', (_, data) => callback(data));
  },
  /** Close / hide the debug window */
  close: () => ipcRenderer.send('debug:close'),
});
