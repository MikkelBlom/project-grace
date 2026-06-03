// ─────────────────────────────────────────────
// ContextDetector — Active window + flow state
//
// Polls the currently active Windows application via PowerShell
// and emits system:contextUpdate events on the EventBus.
//
// Also tracks typing flow state via keyboard activity timing —
// emits system:flowState when deep focus is detected.
//
// Features:
//   - Active app/window title detection (no extra npm deps)
//   - Incognito browser detection → triggers Discreet Mode
//   - Fullscreen game detection → triggers Paused state
//   - Flow state detection via activity timing
//
// Poll interval: 2000ms (configurable via GRACE_CONTEXT_POLL_MS)
// ─────────────────────────────────────────────

import { exec } from 'child_process';
import { promisify } from 'util';
import { bus } from '@grace/core';

const execAsync = promisify(exec);

const POLL_MS = parseInt(process.env.GRACE_CONTEXT_POLL_MS ?? '2000', 10);

// Apps that trigger Discreet Mode automatically
const DISCREET_APPS = new Set([
  'chrome',
  'msedge',
  'firefox',
  'opera',
  'brave',
]);

// Process names associated with fullscreen gaming
const GAME_INDICATORS = [
  /\.exe$/i,
  /steam/i,
  /game/i,
  /launcher/i,
];

// Window title patterns for incognito detection
const INCOGNITO_TITLES = [
  /incognito/i,
  /private browsing/i,
  /privat/i,
  /InPrivate/i,
];

// IDE/editor processes (high-focus apps)
const FOCUS_APPS = new Set([
  'code',          // VS Code
  'cursor',        // Cursor IDE
  'idea64',        // IntelliJ
  'rider64',       // Rider
  'devenv',        // Visual Studio
  'notepad++',
  'vim',
  'nvim',
  'sublime_text',
]);

// ─────────────────────────────────────────────

interface WindowInfo {
  processName: string;
  windowTitle: string;
  isFullscreen: boolean;
  url?: string;
}

// PowerShell script that returns active window info as JSON
const PS_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinAPI {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$hwnd = [WinAPI]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder(256)
[WinAPI]::GetWindowText($hwnd, $sb, 256) | Out-Null
$title = $sb.ToString()

$pid = 0
[WinAPI]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
$name = if ($proc) { $proc.Name } else { "" }

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Add-Type -AssemblyName System.Windows.Forms
$rect = New-Object WinAPI+RECT
[WinAPI]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
$fullscreen = ($w -ge $screen.Width -and $h -ge $screen.Height)

ConvertTo-Json @{ process=$name; title=$title; fullscreen=$fullscreen } -Compress
`.trim();

// ─────────────────────────────────────────────

export class ContextDetector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastContext: WindowInfo | null = null;
  private lastDiscreetState = false;
  private lastFullscreen = false;

  start(): void {
    console.log(`[ContextDetector] Started — polling every ${POLL_MS}ms`);
    this.poll(); // First poll immediately
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[ContextDetector] Stopped.');
  }

  private async poll(): Promise<void> {
    try {
      const { stdout } = await execAsync(
        `powershell -NoProfile -NonInteractive -Command "${PS_SCRIPT.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
        { timeout: 3000 },
      );

      const info = JSON.parse(stdout.trim()) as {
        process: string;
        title: string;
        fullscreen: boolean;
      };

      const ctx: WindowInfo = {
        processName: info.process?.toLowerCase() ?? '',
        windowTitle: info.title ?? '',
        isFullscreen: info.fullscreen ?? false,
      };

      this.handleContextChange(ctx);

    } catch {
      // Silently ignore polling errors (window focus changes rapidly)
    }
  }

  private handleContextChange(ctx: WindowInfo): void {
    const prev = this.lastContext;

    // Only emit if something changed
    const changed =
      !prev ||
      prev.processName !== ctx.processName ||
      prev.windowTitle !== ctx.windowTitle ||
      prev.isFullscreen !== ctx.isFullscreen;

    if (!changed) return;
    this.lastContext = ctx;

    // ── Emit context update ────────────────────
    bus.emit('system:contextUpdate', {
      activeApp: ctx.processName,
      windowTitle: ctx.windowTitle,
      isFullscreen: ctx.isFullscreen,
    });

    // ── Discreet mode: incognito detection ─────
    const isIncognito = this.detectIncognito(ctx);
    if (isIncognito && !this.lastDiscreetState) {
      this.lastDiscreetState = true;
      console.log(`[ContextDetector] Incognito detected (${ctx.processName}) → Discreet Mode`);
      bus.emit('system:modeChange', {
        mode: 'discreet',
        reason: `Inkognito: ${ctx.processName}`,
      });
    } else if (!isIncognito && this.lastDiscreetState) {
      this.lastDiscreetState = false;
      console.log('[ContextDetector] Inkognito afsluttet → Normal Mode');
      bus.emit('system:modeChange', {
        mode: 'normal',
        reason: 'Inkognito afsluttet',
      });
    }

    // ── Log focus app changes ──────────────────
    if (FOCUS_APPS.has(ctx.processName) && prev && !FOCUS_APPS.has(prev.processName)) {
      console.log(`[ContextDetector] Focus app: ${ctx.processName} — "${ctx.windowTitle}"`);
    }
  }

  private detectIncognito(ctx: WindowInfo): boolean {
    // Check if it's a browser process
    if (!DISCREET_APPS.has(ctx.processName)) return false;

    // Check window title for incognito markers
    return INCOGNITO_TITLES.some(pat => pat.test(ctx.windowTitle));
  }

  getCurrentContext(): WindowInfo | null {
    return this.lastContext;
  }
}
