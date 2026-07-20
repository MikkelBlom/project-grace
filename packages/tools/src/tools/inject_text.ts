// inject_text — type text into the currently-focused control.
//
// Preferred path: UI Automation ValuePattern.SetValue(text) on the focused element.
// That writes the value directly with NO simulated keystrokes — safe, exact, and it
// never leaks into the wrong window. If the focused control has no writable
// ValuePattern, we fall back to System.Windows.Forms.SendKeys.SendWait of the
// LITERAL text only (SendKeys metacharacters +^%~(){}[] are escaped; raw control
// characters are dropped, newlines/tabs become {ENTER}/{TAB}).
//
// Confirm-first: with confirm=false (the default) the tool does NOT type. It returns
// a preview { wouldType, targetWindow, targetElement } so the model/user can approve
// first. Call again with confirm=true to actually inject.
//
// Pure-managed .NET only (UI Automation + System.Windows.Forms). No user32 P/Invoke.

import { registerTool } from '../registry.js';
import { runPowerShell } from '../lib/powershell.js';

// The text is passed as base64 (UTF-8) and decoded inside PowerShell, so quotes,
// newlines, and Unicode survive with zero escaping headaches.
function buildScript(textB64: string, confirm: boolean): string {
  return `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${textB64}'))

$fe = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($fe -eq $null) { ConvertTo-Json @{ ok=$false; error='no-focused-element' } -Compress; exit }

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$root = $fe
while ($root -ne $null -and $root.Current.ControlType.ProgrammaticName -ne 'ControlType.Window') {
  $p = $walker.GetParent($root); if ($p -eq $null) { break }; $root = $p
}
$win = ''; if ($root -ne $null) { try { $win = $root.Current.Name } catch { } }
$elName = ''; try { $elName = $fe.Current.Name } catch { }
$ct = ''; try { $ct = $fe.Current.ControlType.ProgrammaticName } catch { }

if (-not ${confirm ? '$true' : '$false'}) {
  ConvertTo-Json @{ ok=$false; preview=$true; wouldType=$text; targetWindow=$win; targetElement=$elName; controlType=$ct } -Compress
  exit
}

function ConvertTo-SendKeys([string]$s) {
  $out = ''
  foreach ($ch in $s.ToCharArray()) {
    $code = [int]$ch
    if ('+^%~(){}[]'.IndexOf($ch) -ge 0) { $out += '{' + $ch + '}' }
    elseif ($code -eq 10) { $out += '{ENTER}' }
    elseif ($code -eq 9) { $out += '{TAB}' }
    elseif ($code -lt 32) { }
    else { $out += $ch }
  }
  return $out
}

$method = ''
$done = $false
$err = ''

# 1. ValuePattern.SetValue — no keystrokes.
$vp = $null
if ($fe.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
  $vpo = $vp -as [System.Windows.Automation.ValuePattern]
  if (-not $vpo.Current.IsReadOnly) {
    try { $vpo.SetValue($text); $method = 'valuepattern'; $done = $true } catch { $err = $_.Exception.Message }
  } else { $err = 'value-pattern-readonly' }
}

# 2. Fallback: SendKeys of the escaped literal text.
if (-not $done) {
  try {
    $sk = ConvertTo-SendKeys $text
    [System.Windows.Forms.SendKeys]::SendWait($sk)
    $method = 'sendkeys'
    $done = $true
  } catch { $err = $_.Exception.Message }
}

if ($done) { ConvertTo-Json @{ ok=$true; method=$method; targetWindow=$win } -Compress }
else { ConvertTo-Json @{ ok=$false; error=('inject-failed: ' + $err) } -Compress }
`.trim();
}

registerTool({
  name: 'inject_text',
  description:
    'Type text into the currently-focused control. Prefers UI Automation ValuePattern (no ' +
    'simulated keystrokes; replaces the field value); falls back to sending the literal text as ' +
    'keystrokes if needed. Confirm-first: with confirm=false (default) it only PREVIEWS what it ' +
    'would type and where — call again with confirm=true to actually type. Note: ValuePattern ' +
    'replaces the whole field; use inject_to_terminal to append/run a command.',
  params: {
    text:    { type: 'string',  description: 'The text to type into the focused control.', required: true },
    confirm: { type: 'boolean', description: 'Must be true to actually type. Default false returns a preview only.' },
  },
  async run(args) {
    const text = args.text == null ? '' : String(args.text);
    if (!text) return { error: 'inject_text needs some text to type.' };
    const confirm = args.confirm === true || String(args.confirm).toLowerCase() === 'true';
    const b64 = Buffer.from(text, 'utf8').toString('base64');

    const { stdout, stderr, code } = await runPowerShell(buildScript(b64, confirm), 15_000);
    if (code !== 0) return { error: `inject_text failed: ${stderr || `exit ${code}`}` };

    let info: any;
    try { info = JSON.parse(stdout.trim() || '{}'); }
    catch { return { error: `Unexpected inject_text output: ${stdout.trim().slice(0, 200)}` }; }

    if (info.preview) {
      return {
        ok: false,
        preview: true,
        wouldType: info.wouldType ?? text,
        targetWindow: info.targetWindow ?? '',
        targetElement: info.targetElement ?? '',
        controlType: (info.controlType ?? '').replace(/^ControlType\./, ''),
        note: 'Preview only — nothing was typed. Call again with confirm:true to type this into the focused control.',
      };
    }
    if (info.ok) return { ok: true, method: info.method, targetWindow: info.targetWindow ?? '' };
    if (info.error === 'no-focused-element') return { error: 'No control is focused — click into a text field first, then try again.' };
    return { error: info.error ? String(info.error) : 'inject_text did not type anything.' };
  },
});
