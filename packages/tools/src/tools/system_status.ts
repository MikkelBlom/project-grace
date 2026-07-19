import os from 'os';
import { execSync } from 'child_process';
import { registerTool } from '../registry.js';

// Machine health at a glance — CPU/RAM/GPU/disk/uptime. Useful when things feel slow.
registerTool({
  name: 'system_status',
  description: 'Report the machine status: CPU, RAM usage, GPU (VRAM + utilisation if an NVIDIA card is present), uptime, and battery. Use when Mikkel asks how the computer is doing or if things feel slow.',
  params: {},
  async run() {
    const total = os.totalmem();
    const free = os.freemem();
    const cpus = os.cpus?.() ?? [];
    const status: Record<string, unknown> = {
      cpu: { model: cpus[0]?.model ?? 'unknown', cores: cpus.length },
      ram: {
        totalGB: +(total / 1e9).toFixed(1),
        usedGB: +((total - free) / 1e9).toFixed(1),
        usedPct: Math.round((1 - free / total) * 100),
      },
      uptimeHours: +(os.uptime() / 3600).toFixed(1),
      platform: `${os.platform()} ${os.release()}`,
    };

    // GPU (best-effort; NVIDIA only).
    try {
      const out = execSync('nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits', { timeout: 4000 }).toString().trim();
      const [name, used, totalMB, util] = out.split(',').map((s) => s.trim());
      status.gpu = { name, vramUsedMB: Number(used), vramTotalMB: Number(totalMB), utilPct: Number(util) };
    } catch { status.gpu = 'nvidia-smi unavailable'; }

    // Battery (Windows WMIC, best-effort).
    try {
      const out = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Battery).EstimatedChargeRemaining"', { timeout: 4000 }).toString().trim();
      if (out && /^\d+$/.test(out)) status.batteryPct = Number(out);
    } catch { /* desktop / no battery */ }

    return status;
  },
});
