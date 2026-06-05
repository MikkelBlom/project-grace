// Shared PowerShell runner for tools that need Win32/desktop access.
//
// Scripts are passed via -EncodedCommand (base64 UTF-16LE). This runs the whole
// multi-line script — including Add-Type C# here-strings — as a single argument,
// avoiding the stdin/`-Command -` parser quirks that silently swallow here-strings
// and all quote-escaping headaches.
//
// Windows PowerShell (powershell.exe) is used deliberately: it runs DPI-UNAWARE
// by default, so Screen.Bounds and screen captures report Windows logical/DIP
// units that line up 1:1 with Electron's `screen` bounds and the click-through
// overlay's CSS pixels. That alignment is what lets analyze_screen coordinates
// feed focus_box without per-monitor DPI math.

import { spawn } from 'child_process';

export interface PsResult { stdout: string; stderr: string; code: number; }

export function runPowerShell(script: string, timeoutMs = 15000): Promise<PsResult> {
  return new Promise((resolve) => {
    // Prefix forces UTF-8 on the output pipe so non-ASCII titles/paths survive.
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
