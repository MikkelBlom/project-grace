import { execSync } from 'child_process';
import { registerTool } from '../registry.js';

// Top running processes — useful when the machine feels slow ("what's hogging memory?").
registerTool({
  name: 'list_processes',
  description: 'List the top running processes by memory (or CPU). Use when Mikkel asks what is running or what is using resources.',
  params: {
    by: { type: 'string', description: '"memory" (default) or "cpu"' },
    top: { type: 'number', description: 'how many to list (default 12, max 30)' },
  },
  async run(args) {
    const by = String(args.by ?? 'memory').toLowerCase() === 'cpu' ? 'CPU' : 'WorkingSet';
    const top = Math.max(1, Math.min(30, Number(args.top) || 12));
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-Process | Sort-Object ${by} -Descending | Select-Object -First ${top} Name,@{N='MemMB';E={[math]::Round($_.WorkingSet/1MB)}},@{N='CPUsec';E={[math]::Round($_.CPU,1)}} | ConvertTo-Json -Compress"`,
        { timeout: 8000 },
      ).toString().trim();
      const data = JSON.parse(out);
      return { by: by === 'CPU' ? 'cpu' : 'memory', processes: Array.isArray(data) ? data : [data] };
    } catch (e) { return { error: String(e).slice(0, 200) }; }
  },
});
