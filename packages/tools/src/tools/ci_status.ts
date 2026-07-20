import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { registerTool } from '../registry.js';

function isRepo(dir: string): boolean { return fs.existsSync(path.join(dir, '.git')); }

// Latest GitHub Actions runs for a repo, via the gh CLI.
registerTool({
  name: 'ci_status',
  description: 'Report the latest GitHub Actions / CI runs for a repo (workflow, status, conclusion, branch, when) using the GitHub CLI. Use when Mikkel asks whether CI passed or how the build is doing.',
  params: {
    path: { type: 'string', description: 'the repo folder (default: current working directory)' },
    count: { type: 'number', description: 'how many recent runs to show (default 5, max 20)' },
  },
  async run(args) {
    const dir = path.resolve(String(args.path ?? process.cwd()));
    if (!isRepo(dir)) return { error: `not a git repo: ${dir}` };
    const n = Math.max(1, Math.min(20, Number(args.count) || 5));

    const fields = 'workflowName,displayTitle,status,conclusion,headBranch,event,createdAt,url';
    let out = '';
    try {
      out = execFileSync('gh', ['run', 'list', '--limit', String(n), '--json', fields], {
        cwd: dir, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
      }).toString();
    } catch (e) {
      const msg = String(e);
      if (/ENOENT|not recognized|not found/i.test(msg)) {
        return { error: 'gh (GitHub CLI) not found — install it to check CI status.' };
      }
      if (/gh auth login|not logged|authentication|HTTP 401/i.test(msg)) {
        return { error: 'gh is not authenticated — run `gh auth login` first.' };
      }
      if (/no.*remote|could not determine|not a github repo|not found/i.test(msg)) {
        return { error: 'no GitHub repo detected here (no GitHub remote?).', detail: msg.slice(0, 200) };
      }
      return { error: 'gh run list failed', detail: msg.slice(0, 200) };
    }

    let runs: any[] = [];
    try { runs = JSON.parse(out || '[]'); } catch { return { error: 'could not parse gh output' }; }
    if (!runs.length) return { repo: dir, count: 0, runs: [], note: 'no CI runs found' };

    const clean = runs.map((r) => ({
      workflow: r.workflowName ?? '',
      title: r.displayTitle ?? '',
      branch: r.headBranch ?? '',
      event: r.event ?? '',
      status: r.status ?? '',
      conclusion: r.conclusion ?? '',
      when: r.createdAt ?? '',
    }));
    return { repo: dir, count: clean.length, runs: clean };
  },
});
