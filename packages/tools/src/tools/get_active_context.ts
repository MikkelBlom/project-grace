// get_active_context — what is the user doing right now?
//
// Runs a live query for the foreground window (app name, title, fullscreen) and
// optionally reads the currently selected text. Selection is read directly via
// UI Automation's TextPattern — NOT by simulating Ctrl+C. Simulating ^c globally
// is dangerous: SendKeys delivers the keystroke to whatever window has focus, and
// if that is a console (e.g. the terminal running Grace) the Ctrl+C arrives as
// SIGINT and kills the process. TextPattern reads the selection with zero input
// simulation and zero clipboard clobbering.

import { registerTool } from '../registry.js';
import { runPowerShell } from '../lib/powershell.js';

// PowerShell: report the focused window as compact JSON, using UI Automation +
// System.Windows.Forms ONLY. We deliberately avoid user32 P/Invoke
// (GetForegroundWindow / GetWindowText) because AMSI/antivirus flags that pattern
// as malicious and blocks the script. UI Automation's FocusedElement gives us the
// element, its process id, the containing window's title and bounding rectangle —
// all in pure managed code that AV is happy with.
const ACTIVE_WINDOW_PS = `
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
$fs = $false
if ($bw -gt 0) {
  $rect = New-Object System.Drawing.Rectangle([int]$bx, [int]$by, [int]$bw, [int]$bh)
  $scr = [System.Windows.Forms.Screen]::FromRectangle($rect).Bounds
  $fs = ($bw -ge $scr.Width -and $bh -ge $scr.Height)
}
ConvertTo-Json @{ app=$name; title=$title; isFullscreen=$fs } -Compress
`.trim();

// PowerShell: read the selected text from the focused element via UI Automation's
// TextPattern. No keystrokes, no clipboard — completely safe. Returns {} JSON with
// "selection" (empty if the element doesn't expose a text selection).
const SELECTION_PS = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$fe = [System.Windows.Automation.AutomationElement]::FocusedElement
$sel = ""
$supported = $false
if ($fe) {
  $obj = $null
  if ($fe.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$obj)) {
    $supported = $true
    $tp = $obj -as [System.Windows.Automation.TextPattern]
    try {
      $ranges = $tp.GetSelection()
      if ($ranges -and $ranges.Length -gt 0) {
        $parts = @()
        foreach ($rng in $ranges) { $parts += $rng.GetText(-1) }
        $sel = ($parts -join "")
      }
    } catch { }
  }
}
ConvertTo-Json @{ selection=$sel; supported=$supported } -Compress
`.trim();

registerTool({
  name: 'get_active_context',
  description:
    'Get what the user is currently doing: active app name, window title, and fullscreen state. ' +
    'Optionally read the currently selected text (via UI Automation — no keystrokes, safe). ' +
    'Use to understand the user\'s current context before acting.',
  params: {
    include_selection: {
      type: 'boolean',
      description: 'If true, also read the currently selected text from the focused control. Default false.',
    },
  },
  async run(args) {
    const result: {
      app: string; title: string; isFullscreen: boolean;
      selectedText?: string; selectionNote?: string;
    } = { app: '', title: '', isFullscreen: false };

    // ── 1. Live active-window query ──────────────────────────────────────────
    const { stdout, stderr, code } = await runPowerShell(ACTIVE_WINDOW_PS);
    if (code !== 0) {
      return { error: `Could not read the active window: ${stderr || `exit ${code}`}` };
    }
    try {
      const info = JSON.parse(stdout.trim()) as { app?: string; title?: string; isFullscreen?: boolean };
      result.app = info.app ?? '';
      result.title = info.title ?? '';
      result.isFullscreen = !!info.isFullscreen;
    } catch {
      return { error: `Unexpected active-window output: ${stdout.trim().slice(0, 200)}` };
    }

    // ── 2. Optional selected-text capture (UI Automation TextPattern) ────────
    if (args.include_selection) {
      try {
        const r = await runPowerShell(SELECTION_PS);
        if (r.code === 0) {
          const info = JSON.parse(r.stdout.trim()) as { selection?: string; supported?: boolean };
          const sel = (info.selection ?? '').trim();
          if (sel) result.selectedText = sel;
          else if (!info.supported) result.selectionNote = 'The focused control does not expose a text selection.';
          else result.selectionNote = 'Nothing is currently selected.';
        } else {
          result.selectionNote = `Selection read failed: ${r.stderr || `exit ${r.code}`}`;
        }
      } catch (e) {
        result.selectionNote = `Selection read failed: ${String(e)}`;
      }
    }

    return result;
  },
});
