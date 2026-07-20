import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { registerTool } from '../registry.js';

const PY = process.env.GRACE_PYTHON_CMD ?? 'py';
const PY_VER = process.env.GRACE_PYTHON_VER ?? '-3.12';

// "What changed on my screen?" — capture two screenshots a moment apart and report changed regions.
registerTool({
  name: 'screen_diff',
  description: 'Detect what changed on screen over a short interval — captures two screenshots ~N seconds apart and reports the changed region(s) + how much changed. Use when Mikkel asks what changed, or to watch for a screen update. Needs Python Pillow (pip install pillow).',
  params: { seconds: { type: 'number', description: 'seconds between the two captures (default 2, max 30)' } },
  async run(args, ctx) {
    if (!ctx) return { error: 'screen_diff needs tool context' };
    const wait = Math.max(1, Math.min(30, Number(args.seconds) || 2));
    const a = (await ctx.callTool('take_screenshot', {})) as any;
    const imgA = a?.path || a?.file || (Array.isArray(a?.paths) ? a.paths[0] : undefined);
    if (!imgA || !fs.existsSync(imgA)) return { error: 'could not capture the first screenshot' };
    await new Promise((r) => setTimeout(r, wait * 1000));
    const b = (await ctx.callTool('take_screenshot', {})) as any;
    const imgB = b?.path || b?.file || (Array.isArray(b?.paths) ? b.paths[0] : undefined);
    if (!imgB || !fs.existsSync(imgB)) return { error: 'could not capture the second screenshot' };

    const code = `import sys\nfrom PIL import Image, ImageChops\na=Image.open(sys.argv[1]).convert('RGB');b=Image.open(sys.argv[2]).convert('RGB')\nif a.size!=b.size: b=b.resize(a.size)\ndiff=ImageChops.difference(a,b).convert('L')\nbbox=diff.getbbox()\nimport json\nhist=diff.histogram();changed=sum(hist[20:]);total=a.size[0]*a.size[1]\nprint(json.dumps({'changedPct':round(100*changed/total,2),'bbox':bbox,'size':a.size}))`;
    try {
      const out = execFileSync(PY, [...(PY_VER ? [PY_VER] : []), '-c', code, imgA, imgB], { timeout: 20000 }).toString().trim();
      const r = JSON.parse(out);
      return {
        changedPercent: r.changedPct,
        changedRegion: r.bbox ? { x: r.bbox[0], y: r.bbox[1], w: r.bbox[2] - r.bbox[0], h: r.bbox[3] - r.bbox[1] } : null,
        note: r.changedPct < 0.1 ? 'Screen looks essentially unchanged.' : `About ${r.changedPct}% of the screen changed.`,
      };
    } catch (e) {
      return { error: `Diff failed — install Pillow (${PY} ${PY_VER} -m pip install pillow). ${String(e).slice(0, 120)}` };
    }
  },
});
