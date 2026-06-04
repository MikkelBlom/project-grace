import { registerTool } from '../registry.js';

// Grace's own git access — deliberately narrow so she can save her work WITHOUT being able
// to touch anything else:
//   • only commits on a grace/* branch (refuses on main / feat/* / anything else);
//   • only stages tool source under packages/tools (never her core brain);
//   • only commits — never checkout, merge, rebase, push, reset. A commit on one branch
//     cannot affect another, so her own branch keeps the rest of the repo safe.
registerTool({
  name: 'git_commit',
  description: 'Commit the tools you just built to git, on YOUR OWN branch. Only works on a grace/* branch and only commits tool files under packages/tools — never your core code, never main or feat/* branches, and it never pushes, switches, merges or resets. Use it after a tool is built and validated so your work is saved.',
  params: {
    message: { type: 'string', description: 'a clear commit message describing the tool(s) added', required: true },
  },
  async run(args) {
    const { spawnSync } = await import('child_process');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const repoRoot = process.env.GRACE_REPO_ROOT
      ? path.resolve(process.env.GRACE_REPO_ROOT)
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const git = (a: string[]) => spawnSync('git', a, { cwd: repoRoot, encoding: 'utf-8' });

    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout?.trim();
    if (!branch || !branch.startsWith('grace/')) {
      return { ok: false, committed: false, error: `Refusing to commit: current branch is "${branch || '?'}", not a grace/* branch. Mikkel must checkout a grace/* branch before I commit.` };
    }

    // Stage ONLY tool source — never the brain (llm/core/overlay/shared/scripts/sandbox).
    git(['add', 'packages/tools/src/tools', 'packages/tools/src/index.ts']);
    const staged = git(['diff', '--cached', '--name-only']).stdout?.trim();
    if (!staged) return { ok: true, committed: false, message: 'nothing new to commit' };

    const msg = (String(args.message ?? '').trim() || 'Add self-built tool') + '\n\nBuilt autonomously by Grace.';
    const res = git(['commit', '-m', msg]);
    if (res.status !== 0) {
      return { ok: false, committed: false, error: (res.stderr || res.stdout || 'git commit failed').slice(-400) };
    }
    const hash = git(['rev-parse', '--short', 'HEAD']).stdout?.trim();
    return { ok: true, committed: true, branch, hash, files: staged.split('\n') };
  },
});
