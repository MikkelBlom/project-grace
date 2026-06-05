// take_screenshot — capture the screen so Grace can "see" it.
//
// monitor:
//   "active" (default) — the monitor the focused window is on ("where I am")
//   "all"              — every connected monitor, one PNG each
//   "primary"          — the primary monitor
//   <number>           — a specific monitor, 1-based (1 = first)
//
// Each PNG is captured with a DPI-unaware PowerShell process, so its pixels are
// Windows logical/DIP units that line up with Electron `screen` bounds and the
// overlay's CSS pixels. Alongside each PNG we write a `<file>.json` sidecar with
// that monitor's absolute virtual-desktop bounds, so analyze_screen can convert
// the model's percentage coordinates into absolute screen pixels for focus_box.

import { registerTool } from '../registry.js';
import { runPowerShell } from '../lib/powershell.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

interface Capture {
  path: string; monitorIndex: number; isActive: boolean; primary: boolean;
  x: number; y: number; width: number; height: number;
}

function repoRoot(): string {
  if (process.env.GRACE_REPO_ROOT) return path.resolve(process.env.GRACE_REPO_ROOT);
  // dist/tools/<file>.js → up 4 to the grace repo root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

/** Parse the `monitor` arg into a PowerShell mode + 0-based index. */
function parseMonitor(raw: unknown): { mode: 'active' | 'all' | 'primary' | 'index'; index: number } {
  if (raw == null) return { mode: 'active', index: -1 };
  if (typeof raw === 'number' && Number.isFinite(raw)) return { mode: 'index', index: Math.trunc(raw) - 1 };
  const s = String(raw).trim().toLowerCase();
  if (s === 'all') return { mode: 'all', index: -1 };
  if (s === 'primary' || s === 'main') return { mode: 'primary', index: -1 };
  if (s === 'active' || s === 'me' || s === 'here' || s === 'where i am' || s === 'current') {
    return { mode: 'active', index: -1 };
  }
  const n = parseInt(s, 10);
  if (Number.isFinite(n)) return { mode: 'index', index: n - 1 };
  return { mode: 'active', index: -1 };
}

function buildScript(mode: string, index: number, outDir: string, ts: number): string {
  // outDir/ts are tool-generated (not user input); still, keep them literal.
  // Pure managed APIs only — no user32 P/Invoke, which AMSI/antivirus blocks.
  // The "active" screen is the one the mouse cursor is on ("where I am").
  const dir = outDir.replace(/'/g, "''");
  return `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$mode = '${mode}'
$index = ${index}
$outDir = '${dir}'
$ts = '${ts}'
$all = [System.Windows.Forms.Screen]::AllScreens
$cur = [System.Windows.Forms.Cursor]::Position
$activeScreen = [System.Windows.Forms.Screen]::FromPoint($cur)
$results = @()
for ($i = 0; $i -lt $all.Count; $i++) {
  $s = $all[$i]
  $isActive = ($s.DeviceName -eq $activeScreen.DeviceName)
  $capture = $false
  switch ($mode) {
    'all'     { $capture = $true }
    'primary' { $capture = $s.Primary }
    'index'   { $capture = ($i -eq $index) }
    default   { $capture = $isActive }
  }
  if (-not $capture) { continue }
  $b = $s.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $file = Join-Path $outDir ("$ts-mon$i.png")
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  $results += @{ path=$file; monitorIndex=$i; isActive=$isActive; primary=[bool]$s.Primary; x=$b.X; y=$b.Y; width=$b.Width; height=$b.Height }
}
ConvertTo-Json -InputObject @($results) -Compress -Depth 4
`.trim();
}

registerTool({
  name: 'take_screenshot',
  description:
    'Capture a screenshot so Grace can see the screen. ' +
    'monitor: "active" (default — the monitor you are working on), "all" (every monitor), ' +
    '"primary", or a monitor number (1-based). Returns the saved PNG path(s). ' +
    'Use before analyze_screen to give Grace vision of what is on screen.',
  params: {
    monitor: {
      type: 'string',
      description: '"active" (default), "all", "primary", or a monitor number (1-based, e.g. "2").',
    },
  },
  async run(args) {
    const { mode, index } = parseMonitor(args.monitor);
    const outDir = path.join(repoRoot(), 'data', 'screenshots');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { return { error: `Could not create screenshot dir: ${String(e)}` }; }

    const ts = Date.now();
    const { stdout, stderr, code } = await runPowerShell(buildScript(mode, index, outDir, ts), 20000);
    if (code !== 0) return { error: `Screenshot failed: ${stderr || `exit ${code}`}` };

    let parsed: unknown;
    try { parsed = JSON.parse(stdout.trim() || '[]'); }
    catch { return { error: `Unexpected screenshot output: ${stdout.trim().slice(0, 200)}` }; }

    const captures: Capture[] = Array.isArray(parsed) ? parsed : [parsed as Capture];
    if (captures.length === 0) {
      return { error: mode === 'index' ? `No monitor at index ${index + 1}.` : 'No monitor matched the request.' };
    }

    // Write a bounds sidecar next to each PNG so analyze_screen can map model
    // percentage coords → absolute virtual-desktop pixels for focus_box.
    const screenshots = captures.map((c) => {
      try {
        fs.writeFileSync(`${c.path}.json`, JSON.stringify({
          monitorIndex: c.monitorIndex, isActive: c.isActive, primary: c.primary,
          bounds: { x: c.x, y: c.y, width: c.width, height: c.height },
        }));
      } catch { /* sidecar is best-effort */ }
      return {
        path: c.path,
        width: c.width,
        height: c.height,
        bounds: { x: c.x, y: c.y, width: c.width, height: c.height },
        monitorIndex: c.monitorIndex,
        isActive: c.isActive,
        primary: c.primary,
      };
    });

    // Convenience: top-level path points at the active capture (or the first).
    const lead = screenshots.find((s) => s.isActive) ?? screenshots[0]!;
    return {
      path: lead.path,
      width: lead.width,
      height: lead.height,
      monitorCount: screenshots.length,
      screenshots,
    };
  },
});
