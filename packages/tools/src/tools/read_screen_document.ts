// read_screen_document — read the text of the foreground window's main document.
//
// Reads what the user is looking at (a document, editor, text box, web article's
// text area, chat log, etc.) via UI Automation only — no keystrokes, no clipboard.
// Strategy, in order:
//   1. TextPattern on the focused element (DocumentRange.GetText) — the full text.
//   2. ValuePattern on the focused element (Current.Value).
//   3. Walk the foreground window for a Document or Edit control and read that.
// Returns { window, text, source }. Text is capped (maxChars).
//
// Pure-managed .NET (System.Windows.Automation). No user32 P/Invoke (AMSI-safe).

import { registerTool } from '../registry.js';
import { runPowerShell } from '../lib/powershell.js';

// [char]10 is used for newline joins to avoid backticks inside this template literal.
function buildScript(maxChars: number): string {
  return `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$cap = ${maxChars}
$fe = [System.Windows.Automation.AutomationElement]::FocusedElement
$text = ''
$window = ''
$source = ''
if ($fe -ne $null) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $root = $fe
  while ($root -ne $null -and $root.Current.ControlType.ProgrammaticName -ne 'ControlType.Window') {
    $p = $walker.GetParent($root)
    if ($p -eq $null) { break }
    $root = $p
  }
  if ($root -ne $null) { try { $window = $root.Current.Name } catch { } }

  # 1. TextPattern on the focused element (richest source).
  $tp = $null
  if ($fe.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
    try { $text = ($tp -as [System.Windows.Automation.TextPattern]).DocumentRange.GetText($cap); if (-not [string]::IsNullOrEmpty($text)) { $source = 'focused-textpattern' } } catch { }
  }

  # 2. ValuePattern on the focused element.
  if ([string]::IsNullOrEmpty($text)) {
    $vp = $null
    if ($fe.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      try { $text = ($vp -as [System.Windows.Automation.ValuePattern]).Current.Value; if (-not [string]::IsNullOrEmpty($text)) { $source = 'focused-valuepattern' } } catch { }
    }
  }

  # 3. Walk the window for a Document or Edit control and read it.
  if ([string]::IsNullOrEmpty($text) -and $root -ne $null) {
    try {
      $cond = New-Object System.Windows.Automation.OrCondition(
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)),
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit))
      )
      $doc = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
      if ($doc -ne $null) {
        $tp2 = $null
        if ($doc.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp2)) {
          try { $text = ($tp2 -as [System.Windows.Automation.TextPattern]).DocumentRange.GetText($cap); if (-not [string]::IsNullOrEmpty($text)) { $source = 'document-textpattern' } } catch { }
        }
        if ([string]::IsNullOrEmpty($text)) {
          $vp2 = $null
          if ($doc.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp2)) {
            try { $text = ($vp2 -as [System.Windows.Automation.ValuePattern]).Current.Value; if (-not [string]::IsNullOrEmpty($text)) { $source = 'document-valuepattern' } } catch { }
          }
        }
      }
    } catch { }
  }
}
ConvertTo-Json @{ window=$window; text=$text; source=$source } -Compress
`.trim();
}

registerTool({
  name: 'read_screen_document',
  description:
    "Read the text content of the foreground window's main document/editor via UI Automation " +
    '(the document, text box, article, or code the user is looking at). No keystrokes, safe. ' +
    'Use to answer questions about, summarize, or proofread whatever is on screen.',
  params: {
    maxChars: { type: 'number', description: 'Max characters to return (default 8000, max 40000).' },
  },
  async run(args) {
    const cap = Math.max(500, Math.min(40000, Number(args.maxChars) || 8000));
    const { stdout, stderr, code } = await runPowerShell(buildScript(cap), 20_000);
    if (code !== 0) {
      return { error: `Could not read the on-screen document: ${stderr || `exit ${code}`}` };
    }
    try {
      const info = JSON.parse(stdout.trim()) as { window?: string; text?: string; source?: string };
      const full = info.text ?? '';
      const text = full.length > cap ? full.slice(0, cap) : full;
      if (!text.trim()) {
        return {
          window: (info.window ?? '').trim(),
          text: '',
          note: 'The foreground window did not expose any readable document text via UI Automation.',
        };
      }
      return {
        window: (info.window ?? '').trim(),
        source: info.source || 'unknown',
        chars: full.length,
        truncated: full.length > cap,
        text,
      };
    } catch {
      return { error: `Unexpected document output: ${stdout.trim().slice(0, 200)}` };
    }
  },
});
