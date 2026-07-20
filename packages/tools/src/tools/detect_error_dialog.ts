// detect_error_dialog — spot error/alert/warning dialogs on the desktop.
//
// Enumerates top-level windows via UI Automation (RootElement children) and flags
// the ones that look like error or alert dialogs: a title containing error/warning
// keywords (English + Danish), the classic Win32 dialog class (#32770), or a modal
// window carrying OK/Cancel/Yes/No-style buttons. For each match it returns the
// title, the visible Text-control content, and the button labels.
//
// Pure-managed .NET (System.Windows.Automation). No user32 P/Invoke (AMSI-safe).
// A cheap "hint" pre-filter avoids walking giant control trees (e.g. browsers).

import { registerTool } from '../registry.js';
import { runPowerShell } from '../lib/powershell.js';

// [char]10 joins body-text lines (avoids backticks inside this template literal).
const DETECT_PS = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
$keywords = @('error','fejl','warning','advarsel','alert','failed','failure','exception','problem','cannot','couldn','could not','kunne ikke','invalid','ugyldig','denied','nægtet')
$dialogButtons = @('ok','cancel','annuller','yes','no','ja','nej','retry','prøv igen','abort','ignore','close','luk','continue','fortsæt')
$dialogs = @()
foreach ($w in $wins) {
  try {
    if ($w.Current.IsOffscreen) { continue }
    $title = ''
    try { $title = $w.Current.Name } catch { }
    $cls = ''
    try { $cls = $w.Current.ClassName } catch { }
    $isModal = $false
    $wp = $null
    if ($w.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) {
      try { $isModal = ($wp -as [System.Windows.Automation.WindowPattern]).Current.IsModal } catch { }
    }
    $lower = $title.ToLower()
    $titleMatch = $false
    foreach ($k in $keywords) { if ($lower.Contains($k)) { $titleMatch = $true; break } }

    # Cheap pre-filter: only inspect descendants when there is a real hint this is a dialog.
    $hint = $titleMatch -or $isModal -or ($cls -eq '#32770')
    if (-not $hint) { continue }

    $btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $btns = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    $btnNames = @()
    foreach ($b in $btns) { try { $n = $b.Current.Name; if (-not [string]::IsNullOrEmpty($n)) { $btnNames += $n } } catch { } }
    $hasDialogButtons = $false
    foreach ($bn in $btnNames) { if ($dialogButtons -contains $bn.ToLower().Trim()) { $hasDialogButtons = $true; break } }

    $looksDialog = $titleMatch -or ($cls -eq '#32770' -and $hasDialogButtons) -or ($isModal -and $hasDialogButtons)
    if (-not $looksDialog) { continue }

    $textCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
    $texts = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCond)
    $parts = @()
    foreach ($t in $texts) { try { $n = $t.Current.Name; if (-not [string]::IsNullOrEmpty($n)) { $parts += $n } } catch { } }
    $body = ($parts -join ([char]10))

    $dialogs += @{ title=$title; text=$body; buttons=$btnNames; isModal=[bool]$isModal; className=$cls; titleMatchedKeyword=[bool]$titleMatch }
  } catch { }
}
ConvertTo-Json -InputObject @($dialogs) -Compress -Depth 4
`.trim();

interface Dialog {
  title: string; text: string; buttons: string[]; isModal: boolean;
  className: string; titleMatchedKeyword: boolean;
}

registerTool({
  name: 'detect_error_dialog',
  description:
    'Scan the desktop for open error, warning, or alert dialog boxes via UI Automation and ' +
    'report their title, message text, and buttons. Use to notice when something has gone ' +
    'wrong on screen (a crash box, a "cannot..." warning, a confirmation prompt) and help the user respond.',
  params: {},
  async run() {
    const { stdout, stderr, code } = await runPowerShell(DETECT_PS, 20_000);
    if (code !== 0) {
      return { error: `Could not scan for dialogs: ${stderr || `exit ${code}`}` };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(stdout.trim() || '[]'); }
    catch { return { error: `Unexpected dialog-scan output: ${stdout.trim().slice(0, 200)}` }; }

    const raw: Dialog[] = Array.isArray(parsed) ? parsed as Dialog[] : [parsed as Dialog];
    const dialogs = raw
      .filter((d) => d && (d.title || d.text))
      .map((d) => ({
        title: (d.title ?? '').trim(),
        text: (d.text ?? '').replace(/\r\n/g, '\n').trim().slice(0, 2000),
        buttons: Array.isArray(d.buttons) ? d.buttons.map((b) => String(b).trim()).filter(Boolean) : [],
        isModal: !!d.isModal,
        kind: d.titleMatchedKeyword ? 'error/warning' : 'dialog',
      }));

    if (dialogs.length === 0) {
      return { dialogs: [], count: 0, note: 'No error, warning, or alert dialogs are currently open.' };
    }
    return { dialogs, count: dialogs.length };
  },
});
