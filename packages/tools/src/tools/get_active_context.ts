// get_active_context — what is the user doing right now?
//
// Runs a live query for the foreground window (app name, title, fullscreen) and
// optionally grabs the currently selected text by simulating Ctrl+C and reading
// the clipboard. The prior clipboard contents are saved and restored so we don't
// clobber whatever the user had copied.

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

// PowerShell: send Ctrl+C to the foreground window so its selection lands on the
// clipboard. A short sleep lets the target app finish the copy.
const COPY_SELECTION_PS = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("^c")
Start-Sleep -Milliseconds 180
`.trim();

registerTool({
  name: 'get_active_context',
  description:
    'Get what the user is currently doing: active app name, window title, and fullscreen state. ' +
    'Optionally grab the currently selected text (simulates Ctrl+C, reads the clipboard, then restores it). ' +
    'Use to understand the user\'s current context before acting.',
  params: {
    include_selection: {
      type: 'boolean',
      description: 'If true, simulate Ctrl+C and read the selected text via the clipboard. Default false.',
    },
  },
  async run(args, ctx) {
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

    // ── 2. Optional selected-text capture (clipboard-based) ──────────────────
    if (args.include_selection && ctx) {
      try {
        const before = (await ctx.callTool('clipboard_read', {})) as { text?: string; error?: string };
        const priorClip = before?.text ?? '';

        await runPowerShell(COPY_SELECTION_PS);

        const after = (await ctx.callTool('clipboard_read', {})) as { text?: string; error?: string };
        const sel = (after?.text ?? '').trim();

        // Restore the user's original clipboard (text only).
        await ctx.callTool('clipboard_write', { text: priorClip });

        if (sel && sel !== priorClip.trim()) {
          result.selectedText = sel;
        } else {
          result.selectionNote = 'No new selection detected (nothing was selected, or the app ignored Ctrl+C).';
        }
      } catch (e) {
        result.selectionNote = `Selection capture failed: ${String(e)}`;
      }
    }

    return result;
  },
});
