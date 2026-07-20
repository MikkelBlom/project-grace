// inject_to_terminal — append a command to the focused terminal or editor.
//
// Like inject_text, but tuned for terminals/editors where you want to APPEND (type
// at the caret) rather than replace the whole field, and optionally press Enter to
// run the command. Terminals rarely expose a writable ValuePattern, so the primary
// path is System.Windows.Forms.SendKeys.SendWait of the escaped literal text; the
// optional trailing Enter is a real {ENTER} key (controlled by the `enter` param).
//
// Confirm-first: with confirm=false (default) it PREVIEWS { wouldType, willPressEnter,
// targetWindow } and types nothing. Call again with confirm=true to inject.
//
// Pure-managed .NET only (UI Automation + System.Windows.Forms). No user32 P/Invoke.
// Only the literal command text (plus optional Enter) is ever sent — never other
// control keys or global shortcuts.

import { registerTool } from '../registry.js';
import { runPowerShell } from '../lib/powershell.js';

function buildScript(textB64: string, confirm: boolean, enter: boolean): string {
  return `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${textB64}'))
$enter = ${enter ? '$true' : '$false'}
# When NOT pressing Enter, collapse embedded newlines to spaces so multi-line text can't run
# intermediate lines (an embedded \\n would otherwise become {ENTER} and execute). This makes the
# 'willPressEnter:false' contract truthful — nothing runs until the user presses Enter themselves.
if (-not $enter) { $text = $text -replace '\\r?\\n', ' ' }

$fe = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($fe -eq $null) { ConvertTo-Json @{ ok=$false; error='no-focused-element' } -Compress; exit }

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$root = $fe
while ($root -ne $null -and $root.Current.ControlType.ProgrammaticName -ne 'ControlType.Window') {
  $p = $walker.GetParent($root); if ($p -eq $null) { break }; $root = $p
}
$win = ''; if ($root -ne $null) { try { $win = $root.Current.Name } catch { } }
$ct = ''; try { $ct = $fe.Current.ControlType.ProgrammaticName } catch { }

if (-not ${confirm ? '$true' : '$false'}) {
  ConvertTo-Json @{ ok=$false; preview=$true; wouldType=$text; willPressEnter=$enter; targetWindow=$win; controlType=$ct } -Compress
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

# When NOT pressing Enter, try a keystroke-free append via ValuePattern for editors
# that expose a writable value (read current value, set current+new).
if (-not $enter) {
  $vp = $null
  if ($fe.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
    $vpo = $vp -as [System.Windows.Automation.ValuePattern]
    if (-not $vpo.Current.IsReadOnly) {
      try {
        $cur = $vpo.Current.Value
        if ($cur -eq $null) { $cur = '' }
        $vpo.SetValue($cur + $text)
        $method = 'valuepattern-append'
        $done = $true
      } catch { $err = $_.Exception.Message }
    }
  }
}

# Primary/fallback: type the literal command at the caret, optionally + Enter.
if (-not $done) {
  try {
    $sk = ConvertTo-SendKeys $text
    if ($enter) { $sk = $sk + '{ENTER}' }
    [System.Windows.Forms.SendKeys]::SendWait($sk)
    $method = 'sendkeys'
    $done = $true
  } catch { $err = $_.Exception.Message }
}

if ($done) { ConvertTo-Json @{ ok=$true; method=$method; pressedEnter=$enter; targetWindow=$win } -Compress }
else { ConvertTo-Json @{ ok=$false; error=('inject-failed: ' + $err) } -Compress }
`.trim();
}

registerTool({
  name: 'inject_to_terminal',
  description:
    'Append a command/text to the focused terminal or editor (types at the caret rather than ' +
    'replacing the field). Set enter:true to also press Enter and run it. Confirm-first: with ' +
    'confirm=false (default) it only PREVIEWS the command and whether Enter would be pressed — ' +
    'call again with confirm=true to inject. Use for driving a shell or code editor the user has focused.',
  params: {
    text:    { type: 'string',  description: 'The command or text to append to the focused terminal/editor.', required: true },
    enter:   { type: 'boolean', description: 'If true, also press Enter after typing (runs the command). Default false.' },
    confirm: { type: 'boolean', description: 'Must be true to actually type. Default false returns a preview only.' },
  },
  async run(args) {
    const text = args.text == null ? '' : String(args.text);
    if (!text) return { error: 'inject_to_terminal needs a command/text to append.' };
    const confirm = args.confirm === true || String(args.confirm).toLowerCase() === 'true';
    const enter = args.enter === true || String(args.enter).toLowerCase() === 'true';
    const b64 = Buffer.from(text, 'utf8').toString('base64');

    const { stdout, stderr, code } = await runPowerShell(buildScript(b64, confirm, enter), 15_000);
    if (code !== 0) return { error: `inject_to_terminal failed: ${stderr || `exit ${code}`}` };

    let info: any;
    try { info = JSON.parse(stdout.trim() || '{}'); }
    catch { return { error: `Unexpected inject_to_terminal output: ${stdout.trim().slice(0, 200)}` }; }

    if (info.preview) {
      return {
        ok: false,
        preview: true,
        wouldType: info.wouldType ?? text,
        willPressEnter: !!info.willPressEnter,
        targetWindow: info.targetWindow ?? '',
        controlType: (info.controlType ?? '').replace(/^ControlType\./, ''),
        note: `Preview only — nothing was typed. Call again with confirm:true to append this${enter ? ' and press Enter' : ''}.`,
      };
    }
    if (info.ok) return { ok: true, method: info.method, pressedEnter: !!info.pressedEnter, targetWindow: info.targetWindow ?? '' };
    if (info.error === 'no-focused-element') return { error: 'No terminal/editor is focused — click into it first, then try again.' };
    return { error: info.error ? String(info.error) : 'inject_to_terminal did not type anything.' };
  },
});
