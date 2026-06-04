// ─────────────────────────────────────────────
// Electron main process — bootstraps ALL Grace services
//
// Phase 0: mock pipeline (MockSTT → GraceCore → MockLLM → MockTTS)
// Phase 1: swap mocks for WhisperSTT, OllamaLLM, KokoroTTS
//
// Active in this version:
//   - System tray with power state control (tray.ts)
//   - PowerManager: AC/battery detection, Field Notes Mode
//   - Vignette window: fullscreen edge glow + focus boxes
//   - Multi-monitor: displayIndex config + Ctrl+Shift+M
//   - Context detection: active window + incognito → discreet mode
//   - Mode shortcuts: Ctrl+Shift+D/B/N
// ─────────────────────────────────────────────

import { app, BrowserWindow, ipcMain, screen, globalShortcut } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { GraceCore, PowerManager, bus } from '@grace/core';
import { defaultConfig } from '@grace/shared';
import { setupBridge } from './bridge.js';
import { GraceTray } from './tray.js';
import { VignetteWindow } from './vignetteWindow.js';
import { ContextDetector } from './contextDetector.js';
import { DebugWindow } from './debugWindow.js';

// ── Provider selection (swap here for Phase 1) ─
// Phase 0: all mocks
// Phase 1: set GRACE_LLM_PROVIDER=ollama, GRACE_STT_PROVIDER=whisper, GRACE_TTS_PROVIDER=kokoro
const LLM_PROVIDER = process.env.GRACE_LLM_PROVIDER ?? 'ollama';
const STT_PROVIDER = process.env.GRACE_STT_PROVIDER ?? 'whisper';
const TTS_PROVIDER = process.env.GRACE_TTS_PROVIDER ?? 'kokoro';

let mainWindow:      BrowserWindow    | null = null;
let core:            GraceCore        | null = null;
let stt:             { start(): void; stop(): void } | null = null;
let tray:            GraceTray        | null = null;
let vignetteWin:     VignetteWindow   | null = null;
let powerManager:    PowerManager     | null = null;
let contextDetector: ContextDetector  | null = null;
let debugWin:        DebugWindow      | null = null;
let currentDisplayIndex = defaultConfig.overlay.displayIndex;
// Hotkey toggle state (local mirror — re-syncs on next press if it drifts from real state).
let hotkeyPaused = false;
let hotkeyListening = false;

// ── Display helpers ─────────────────────────────

function getTargetDisplay(): Electron.Display {
  const displays = screen.getAllDisplays();
  const idx = currentDisplayIndex;
  if (idx === -1) return screen.getPrimaryDisplay();
  return displays[idx] ?? displays[0]!;
}

function positionOverlay(): void {
  if (!mainWindow) return;
  const { x, y, width, height } = getTargetDisplay().workArea;
  const bounds = mainWindow.getBounds();
  mainWindow.setPosition(
    x + width  - bounds.width  - 20,
    y + height - bounds.height - 20,
    false,
  );
}

function moveToNextDisplay(): void {
  const count = screen.getAllDisplays().length;
  if (count < 2) {
    bus.emit('overlay:notification', { text: 'Kun én skærm tilsluttet', level: 'info', duration: 2000 });
    return;
  }
  currentDisplayIndex = (currentDisplayIndex + 1) % count;
  positionOverlay();
  bus.emit('overlay:notification', {
    text: `🖥  Skærm ${currentDisplayIndex + 1} af ${count}`,
    level: 'info', duration: 2000,
  });
}

// ── Window creation ─────────────────────────────

function createWindow(): void {
  const display = getTargetDisplay();
  const { x, y, width, height } = display.workArea;

  mainWindow = new BrowserWindow({
    width:  400,
    height: 80,
    x: x + width  - 420,
    y: y + height - 100,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setSkipTaskbar(true);
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (true) { // DevTools always open during development
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ── Service bootstrap ───────────────────────────

// Prepend [HH:MM:SS.mmm] to every console line so the logs show exact timing.
function installTimestamps(): void {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const p3 = (n: number) => String(n).padStart(3, '0');
  const stamp = () => {
    const d = new Date();
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
  };
  (['log', 'info', 'warn', 'error'] as const).forEach((m) => {
    const orig = console[m].bind(console);
    console[m] = (...args: unknown[]) => orig(`[${stamp()}]`, ...args);
  });
}

async function startServices(): Promise<void> {
  const phase = LLM_PROVIDER === 'mock' ? '0' : '1';

  installTimestamps();

  // ── Debug overlay — must be first so it captures startup logs ──
  debugWin = new DebugWindow();
  debugWin.interceptConsole();   // From here on, all console.* goes to overlay too

  console.log('\n+--------------------------------------+');
  console.log(`|     Project Grace -- Phase ${phase}        |`);
  console.log(`|  STT:${STT_PROVIDER.padEnd(7)} LLM:${LLM_PROVIDER.padEnd(7)} TTS:${TTS_PROVIDER.padEnd(6)} |`);
  console.log('+--------------------------------------+\n');

  // ── Core orchestrator ──────────────────────
  core = new GraceCore(defaultConfig);

  // ── Power manager ──────────────────────────
  powerManager = new PowerManager({
    autoPauseOnGame: defaultConfig.power.autoPauseOnGame,
    autoResumeOnAC:  defaultConfig.power.autoResumeOnAC,
  });

  // ── LLM ───────────────────────────────────
  if (LLM_PROVIDER === 'ollama') {
    const { OllamaLLM } = await import('@grace/llm');
    new OllamaLLM();
  } else {
    const { MockLLM } = await import('@grace/llm');
    new MockLLM();
  }

  // ── TTS ───────────────────────────────────
  if (TTS_PROVIDER === 'kokoro') {
    const { KokoroTTS } = await import('@grace/tts');
    new KokoroTTS();
  } else {
    const { MockTTS } = await import('@grace/tts');
    new MockTTS();
  }

  // ── STT ───────────────────────────────────
  if (STT_PROVIDER === 'whisper') {
    const { WhisperSTT } = await import('@grace/stt');
    stt = new WhisperSTT();
  } else {
    const { MockSTT } = await import('@grace/stt');
    stt = new MockSTT();
  }

  // ── Overlay services ───────────────────────
  if (mainWindow) setupBridge(mainWindow);
  vignetteWin = new VignetteWindow();
  if (mainWindow) tray = new GraceTray(mainWindow);

  // ── Context detection (Phase 1+) ──────────
  contextDetector = new ContextDetector();
  contextDetector.start();

  // ── Start STT ─────────────────────────────
  stt?.start();

  console.log('[Grace] All services online.');
  console.log(`  LLM:     ${LLM_PROVIDER}`);
  console.log(`  STT:     ${STT_PROVIDER}`);
  console.log(`  TTS:     ${TTS_PROVIDER}`);
  console.log(`  Context: active-window polling (${process.env.GRACE_CONTEXT_POLL_MS ?? 2000}ms)\n`);
}

// ── Global shortcuts ────────────────────────────

function registerShortcuts(): void {
  // Ctrl+Shift+G — toggle overlay visibility
  globalShortcut.register('CommandOrControl+Shift+G', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });

  // Ctrl+Shift+P — toggle pause
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    tray?.togglePause();
  });

  // Ctrl+Shift+M — move to next display
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    moveToNextDisplay();
  });

  // Ctrl+Shift+D — toggle Discreet Mode
  globalShortcut.register('CommandOrControl+Shift+D', () => {
    const next = core?.getMode() === 'discreet' ? 'normal' : 'discreet';
    bus.emit('system:modeChange', { mode: next, reason: 'keyboard shortcut' });
  });

  // Ctrl+Shift+N — Normal mode
  globalShortcut.register('CommandOrControl+Shift+N', () => {
    bus.emit('system:modeChange', { mode: 'normal', reason: 'keyboard shortcut' });
  });

  // Ctrl+Shift+A — toggle Autopilot mode
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    const next = core?.getMode() === 'autopilot' ? 'normal' : 'autopilot';
    bus.emit('system:modeChange', { mode: next, reason: 'keyboard shortcut' });
  });

  // Ctrl+Shift+L — toggle debug overlay
  globalShortcut.register('CommandOrControl+Shift+L', () => {
    debugWin?.toggle();
  });

  // ── Barge-in / interrupt (work even while Grace is speaking — the mic is deaf then) ──

  // Ctrl+Shift+S — STOP everything now (cancel task/mission, kill speech, back to listening)
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    hotkeyPaused = false;
    bus.emit('control:stop', { reason: 'hotkey' });
  });

  // Ctrl+Shift+Space — pause / resume the running task or mission (toggles)
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    hotkeyPaused = !hotkeyPaused;
    bus.emit(hotkeyPaused ? 'control:pause' : 'control:resume', { reason: 'hotkey' });
  });

  // Ctrl+Shift+. — speak a status report of whatever Grace is doing
  globalShortcut.register('CommandOrControl+Shift+.', () => {
    bus.emit('control:status', {});
  });

  // Ctrl+Shift+H — toggle "hold the floor" listen mode (backup for the spoken trigger)
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    hotkeyListening = !hotkeyListening;
    bus.emit('control:listenMode', { on: hotkeyListening });
  });
}

// ── App lifecycle ────────────────────────────────

app.whenReady().then(async () => {
  createWindow();
  await startServices();
  registerShortcuts();
  // Greet once services settle (give TTS a moment to connect).
  setTimeout(() => {
    if (!core) return;
    const greeting = core.getStartupGreeting();
    console.log(`[Grace] 💬 ${greeting}`);
    bus.emit('overlay:notification', { text: greeting, level: 'info', duration: 6000 });
    bus.emit('tts:speaking', { text: greeting, sessionId: 'startup' });
  }, 3000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stt?.stop();
    globalShortcut.unregisterAll();
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stt?.stop();
  tray?.destroy();
  vignetteWin?.destroy();
  contextDetector?.stop();
  debugWin?.destroy();
});
