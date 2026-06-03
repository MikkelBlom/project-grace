// Grace EventBus -> Renderer IPC bridge
// Translates internal bus events into IPC messages the HUD renderer can handle.
// Also handles IPC from renderer back to main (resize, click-through).

import { BrowserWindow, ipcMain, screen } from 'electron';
import { bus } from '@grace/core';

export function setupBridge(win: BrowserWindow): void {
  const send = (data: object) => {
    if (!win.isDestroyed()) {
      win.webContents.send('grace:stateUpdate', data);
    }
  };

  // STT
  bus.on('stt:listening', () => send({ type: 'listening' }));
  bus.on('stt:heard', ({ text }) => send({ type: 'heard', text }));

  // LLM
  bus.on('llm:thinking', () => send({ type: 'thinking' }));
  bus.on('llm:response', ({ text }) => send({ type: 'speaking', text }));

  // TTS
  bus.on('tts:done', () => {
    setTimeout(() => send({ type: 'idle' }), 500);
  });

  // Mode changes
  bus.on('system:modeChange', ({ mode }) => {
    if (mode === 'discreet') {
      send({ type: 'discreet' });
    } else if (mode === 'normal') {
      send({ type: 'normal' });
    } else if (mode === 'brainstorm') {
      send({ type: 'brainstorm' });
    }
  });

  // Power state changes
  bus.on('power:stateChange', ({ state, reason }) => {
    switch (state) {
      case 'field-notes':
        send({ type: 'field-notes', reason });
        break;
      case 'paused':
        send({ type: 'paused', reason });
        break;
      case 'sleeping':
        send({ type: 'paused', reason });
        break;
      case 'active':
        send({ type: 'listening' });
        break;
    }
  });

  // Proactive speech
  bus.on('system:proactiveIntent', ({ text }) => send({ type: 'speaking', text }));

  // Notifications
  bus.on('overlay:notification', ({ text, level, duration }) => {
    send({ type: 'notification', text, level, duration });
  });

  // Field notes summary
  bus.on('power:fieldNotesSummaryReady', ({ noteCount }) => {
    send({
      type: 'notification',
      text: 'Hjemme igen - opsummerer ' + noteCount + ' noter fra dagens session',
      level: 'info',
      duration: 6000,
    });
  });

  // Renderer -> Main: resize overlay window
  ipcMain.on('overlay:resize', (_, { width, height }: { width: number; height: number }) => {
    if (win.isDestroyed()) return;
    const { x } = win.getBounds();
    const display = screen.getDisplayNearestPoint({ x, y: win.getBounds().y });
    const { y: workY, height: workH } = display.workArea;
    const h = Math.ceil(height);
    win.setBounds({ x, y: workY + workH - h - 20, width, height: h });
  });

  // Renderer -> Main: toggle click-through
  ipcMain.on('overlay:setClickThrough', (_, enabled: boolean) => {
    if (!win.isDestroyed()) {
      win.setIgnoreMouseEvents(enabled, { forward: true });
    }
  });
}
