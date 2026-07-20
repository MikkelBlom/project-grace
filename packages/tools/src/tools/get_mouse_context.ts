// get_mouse_context — what UI element is under the mouse cursor right now?
//
// Uses UI Automation's AutomationElement.FromPoint on the live cursor position to
// report the element the user is pointing at: its name, control type, any text it
// exposes (ValuePattern/TextPattern), and the title of the window that contains it.
//
// Pure-managed .NET only (System.Windows.Automation + System.Windows.Forms.Cursor +
// System.Windows.Point). No user32 P/Invoke — AMSI/antivirus blocks that pattern.
// No keystrokes are simulated; state is read entirely through UIA patterns.

import { registerTool } from '../registry.js';
import { runPowerShell } from '../lib/powershell.js';

// FromPoint needs a System.Windows.Point (WPF, double-precision). The cursor gives
// a System.Drawing.Point (integer), so we convert. WindowsBase supplies the Point
// type. We walk up the ControlView tree to the containing ControlType.Window for
// the window title — exactly as get_active_context does.
const MOUSE_CONTEXT_PS = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName WindowsBase
$pos = [System.Windows.Forms.Cursor]::Position
$name = ''; $ct = ''; $val = ''; $win = ''
try {
  $pt = New-Object System.Windows.Point -ArgumentList ([double]$pos.X), ([double]$pos.Y)
  $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
  if ($el -ne $null) {
    try { $name = $el.Current.Name } catch { }
    try { $ct = $el.Current.ControlType.ProgrammaticName } catch { }
    $vp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      try { $val = ($vp -as [System.Windows.Automation.ValuePattern]).Current.Value } catch { }
    }
    if ([string]::IsNullOrEmpty($val)) {
      $tp = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
        try { $val = ($tp -as [System.Windows.Automation.TextPattern]).DocumentRange.GetText(400) } catch { }
      }
    }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $root = $el
    while ($root -ne $null -and $root.Current.ControlType.ProgrammaticName -ne 'ControlType.Window') {
      $p = $walker.GetParent($root)
      if ($p -eq $null) { break }
      $root = $p
    }
    if ($root -ne $null) { try { $win = $root.Current.Name } catch { } }
  }
} catch { }
ConvertTo-Json @{ element=$name; controlType=$ct; value=$val; window=$win; x=$pos.X; y=$pos.Y } -Compress
`.trim();

/** Strip the noisy "ControlType." prefix (ControlType.Button -> Button). */
function shortType(t: string): string {
  return t && t.startsWith('ControlType.') ? t.slice('ControlType.'.length) : t;
}

registerTool({
  name: 'get_mouse_context',
  description:
    'Report the UI element directly under the mouse cursor via UI Automation: its name, ' +
    'control type, any text it exposes, and the window that contains it. ' +
    'Use to understand what the user is pointing at right now (no keystrokes, safe).',
  params: {},
  async run() {
    const { stdout, stderr, code } = await runPowerShell(MOUSE_CONTEXT_PS);
    if (code !== 0) {
      return { error: `Could not read the element under the cursor: ${stderr || `exit ${code}`}` };
    }
    try {
      const info = JSON.parse(stdout.trim()) as {
        element?: string; controlType?: string; value?: string; window?: string; x?: number; y?: number;
      };
      const value = (info.value ?? '').trim();
      return {
        element: (info.element ?? '').trim(),
        controlType: shortType(info.controlType ?? ''),
        value: value.length > 500 ? value.slice(0, 500) + '…' : value,
        window: (info.window ?? '').trim(),
        cursor: { x: info.x ?? 0, y: info.y ?? 0 },
      };
    } catch {
      return { error: `Unexpected mouse-context output: ${stdout.trim().slice(0, 200)}` };
    }
  },
});
