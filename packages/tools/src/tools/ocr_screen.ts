// ocr_screen — pull text off the screen (or an image file) with OCR.
//
// Two engines, tried in order:
//   1. Tesseract CLI (tesseract.exe on PATH) — best quality, many languages.
//   2. Windows.Media.Ocr (built into Windows 10/11, WinRT) — no install needed.
// If neither is available we return a helpful {error} explaining how to install
// Tesseract. With no image_path we first grab a screenshot via take_screenshot.
//
// The Windows OCR path uses pure-managed WinRT projection (Add-Type -AssemblyName
// only, no C#/DllImport) so AMSI/antivirus stays happy.

import { registerTool } from '../registry.js';
import { runPowerShell } from '../lib/powershell.js';
import { execFileSync } from 'child_process';
import fs from 'fs';

// WinRT OCR in Windows PowerShell. Loads the SoftwareBitmap from the PNG on disk,
// runs the OCR engine built from the user's profile languages, and returns JSON.
// Uses [char]10 for newlines to avoid backticks inside this JS template literal.
function windowsOcrScript(imagePath: string): string {
  const p = imagePath.replace(/'/g, "''");
  return `
$ProgressPreference = 'SilentlyContinue'
try {
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation') })[0]
  function Await($op, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $netTask = $asTask.Invoke($null, @($op))
    [void]$netTask.Wait(-1)
    $netTask.Result
  }
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($engine -eq $null) { ConvertTo-Json @{ ok=$false; error='no-ocr-language-pack' } -Compress; exit }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${p}')) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  ConvertTo-Json @{ ok=$true; text=$result.Text } -Compress
} catch {
  ConvertTo-Json @{ ok=$false; error=$_.Exception.Message } -Compress
}
`.trim();
}

const INSTALL_HINT =
  'No OCR engine available. Install Tesseract (https://github.com/UB-Mannheim/tesseract/wiki) ' +
  'and make sure tesseract.exe is on PATH, or install a Windows OCR language pack ' +
  '(Settings > Time & Language > Language > add a language with the "Optical character recognition" feature).';

registerTool({
  name: 'ocr_screen',
  description:
    'Extract text from the screen or an image using OCR. With no image_path, captures a ' +
    'screenshot first. Tries the Tesseract CLI, then falls back to built-in Windows OCR. ' +
    'Use to read text from images, PDFs-as-images, or apps that do not expose their text to UI Automation.',
  params: {
    image_path: { type: 'string', description: 'Path to an image (PNG/JPG). If omitted, a screenshot is taken first.' },
    monitor:    { type: 'string', description: 'Which monitor to screenshot when no image_path is given: "active" (default), "all", "primary", or a number.' },
    lang:       { type: 'string', description: 'Tesseract language code (default "eng"; e.g. "dan" for Danish, "eng+dan" for both).' },
  },
  async run(args, ctx) {
    let imagePath = String(args.image_path ?? '').trim();
    let tookScreenshot = false;

    // Grab a screenshot first if no image was supplied.
    if (!imagePath) {
      if (!ctx?.callTool) return { error: 'ocr_screen needs an image_path (no tool context available to take a screenshot).' };
      const shot = await ctx.callTool('take_screenshot', { monitor: args.monitor ?? 'active' }) as { path?: string; error?: string };
      if (shot?.error) return { error: `Could not capture the screen for OCR: ${shot.error}` };
      imagePath = String(shot?.path ?? '');
      tookScreenshot = true;
      if (!imagePath) return { error: 'Screenshot did not return an image path.' };
    }

    if (!fs.existsSync(imagePath)) return { error: `Image not found: ${imagePath}` };
    const lang = String(args.lang ?? 'eng').trim() || 'eng';

    // ── 1. Tesseract CLI ─────────────────────────────────────────────
    let tesseractMissing = false;
    try {
      const out = execFileSync('tesseract', [imagePath, 'stdout', '-l', lang], {
        timeout: 30_000, maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      const text = out.replace(/\r\n/g, '\n').trim();
      return { engine: 'tesseract', imagePath, tookScreenshot, chars: text.length, text };
    } catch (e: any) {
      // ENOENT means tesseract isn't installed/on PATH — fall through to Windows OCR.
      // Any other error (e.g. bad language) also falls through, but we note it.
      tesseractMissing = e?.code === 'ENOENT';
    }

    // ── 2. Windows.Media.Ocr (WinRT) ─────────────────────────────────
    const { stdout, code } = await runPowerShell(windowsOcrScript(imagePath), 30_000);
    try {
      const info = JSON.parse(stdout.trim() || '{}') as { ok?: boolean; text?: string; error?: string };
      if (info.ok) {
        const text = (info.text ?? '').replace(/\r\n/g, '\n').trim();
        return { engine: 'windows-ocr', imagePath, tookScreenshot, chars: text.length, text };
      }
      // Windows OCR ran but had no language pack, or another WinRT issue.
      return {
        error: `${INSTALL_HINT}${info.error ? ` (Windows OCR: ${info.error})` : ''}`,
        imagePath,
        tesseractInstalled: !tesseractMissing,
      };
    } catch {
      return { error: `${INSTALL_HINT} (exit ${code})`, imagePath, tesseractInstalled: !tesseractMissing };
    }
  },
});
