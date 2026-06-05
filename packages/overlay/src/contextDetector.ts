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

import { spawn } from 'child_process';
import { bus } from '@grace/core';

const POLL_MS = parseInt(process.env.GRACE_CONTEXT_POLL_MS ?? '2000', 10);

// ─────────────────────────────────────────────
// PowerShell runner (-EncodedCommand)
//
// Scripts are passed via -EncodedCommand (base64 UTF-16LE) so the whole
// multi-line script runs as a single argument — no newline→space mangling,
// no quote-escaping. This mirrors packages/tools/src/lib/powershell.ts.
// We don't import that helper because @grace/overlay does not depend on
// @grace/tools, and pulling in a cross-package dependency for one function
// isn't worth it.
// ─────────────────────────────────────────────

interface PsResult { stdout: string; stderr: string; code: number; }

function runPowerShell(script: string, timeoutMs: number): Promise<PsResult> {
  return new Promise((resolve) => {
    // Force UTF-8 on the output pipe so non-ASCII titles survive.
    const full = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' + script;
    const encoded = Buffer.from(full, 'utf16le').toString('base64');

    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
    ]);

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { ps.kill(); } catch { /* noop */ } }, timeoutMs);

    ps.stdout.on('data', (d) => { stdout += d.toString(); });
    ps.stderr.on('data', (d) => { stderr += d.toString(); });
    ps.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr.trim(), code: code ?? -1 });
    });
    ps.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: String(err), code: -1 });
    });
  });
}

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

// PowerShell script that returns active window info as JSON.
//
// Uses UI Automation + System.Windows.Forms ONLY — no user32 P/Invoke
// (GetForegroundWindow / GetWindowText / GetWindowRect). AMSI/antivirus flags
// the `Add-Type [DllImport("user32.dll")]` pattern as malicious and BLOCKS the
// script ("This script contains malicious content..."), which silently killed
// context detection. UI Automation's FocusedElement gives us the element, its
// process id, the containing window's title and bounding rectangle — all in
// pure managed code AV is happy with. Mirrors get_active_context.ts.
const PS_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$fe = [System.Windows.Automation.AutomationElement]::FocusedElement
$title = ""; $procId = 0; $bx = 0; $by = 0; $bw = 0; $bh = 0
if ($fe) {
  $procId = $fe.Current.ProcessId
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $root = $fe
  while ($root -ne $null -and $root.Current.ControlType.ProgrammaticName -ne "ControlType.Window") {
    $p = $walker.GetParent($root)
    if ($p -eq $null) { break }
    $root = $p
  }
  if ($root -ne $null) {
    $title = $root.Current.Name
    $r = $root.Current.BoundingRectangle
    $bx = $r.X; $by = $r.Y; $bw = $r.Width; $bh = $r.Height
  } else {
    $title = $fe.Current.Name
  }
}
$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
$name = if ($proc) { $proc.Name } else { "" }
$fullscreen = $false
if ($bw -gt 0) {
  $rect = New-Object System.Drawing.Rectangle([int]$bx, [int]$by, [int]$bw, [int]$bh)
  $scr = [System.Windows.Forms.Screen]::FromRectangle($rect).Bounds
  $fullscreen = ($bw -ge $scr.Width -and $bh -ge $scr.Height)
}
ConvertTo-Json @{ process=$name; title=$title; fullscreen=$fullscreen } -Compress
`.trim();

// ─────────────────────────────────────────────

export class ContextDetector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastContext: WindowInfo | null = null;
  private lastDiscreetState = false;
  private lastFullscreen = false;
  private loggedPollFailure = false;

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
      const { stdout, stderr, code } = await runPowerShell(PS_SCRIPT, 3000);
      if (code !== 0) {
        this.reportPollFailure(`exit ${code}${stderr ? `: ${stderr}` : ''}`);
        return;
      }

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

      // A clean read clears the failure latch so a later breakage logs again.
      this.loggedPollFailure = false;
      this.handleContextChange(ctx);

    } catch (err) {
      // Transient focus-change races are common; log only the FIRST failure so a
      // real breakage (e.g. AMSI blocking the script) is visible without spamming.
      this.reportPollFailure(String(err));
    }
  }

  // Logs a poll failure once, then stays quiet until the next successful read.
  private reportPollFailure(detail: string): void {
    if (this.loggedPollFailure) return;
    this.loggedPollFailure = true;
    console.warn(`[ContextDetector] Active-window poll failed — context detection paused: ${detail}`);
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
