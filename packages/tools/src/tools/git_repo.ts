import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { registerTool } from '../registry.js';

function isRepo(dir: string): boolean { return fs.existsSync(path.join(dir, '.git')); }

// Read-only git inspection (git_commit stays the only write path, and it's separately gated).
registerTool({
  name: 'git_status',
  description: 'Show the git status of a repository (branch + changed/untracked files). Read-only. Use when Mikkel asks what has changed in a project.',
  params: { path: { type: 'string', description: 'the repo folder (default: current working directory)' } },
  async run(args) {
    const dir = path.resolve(String(args.path ?? process.cwd()));
    if (!isRepo(dir)) return { error: `not a git repo: ${dir}` };
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, timeout: 5000 }).toString().trim();
      const status = execSync('git status --porcelain', { cwd: dir, timeout: 5000 }).toString().trim();
      const files = status ? status.split('\n').map((l) => l.trim()) : [];
      return { repo: dir, branch, changedCount: files.length, files: files.slice(0, 50) };
    } catch (e) { return { error: String(e).slice(0, 200) }; }
  },
});

registerTool({
  name: 'git_log',
  description: 'Show recent git commits of a repository (read-only). Use when Mikkel asks about the recent history of a project.',
  params: {
    path: { type: 'string', description: 'the repo folder (default: cwd)' },
    count: { type: 'number', description: 'how many commits (default 10, max 50)' },
  },
  async run(args) {
    const dir = path.resolve(String(args.path ?? process.cwd()));
    if (!isRepo(dir)) return { error: `not a git repo: ${dir}` };
    const n = Math.max(1, Math.min(50, Number(args.count) || 10));
    try {
      const out = execSync(`git log -${n} --pretty=format:%h|%an|%ar|%s`, { cwd: dir, timeout: 5000 }).toString().trim();
      const commits = out.split('\n').filter(Boolean).map((l) => {
        const [hash, author, when, ...subj] = l.split('|');
        return { hash, author, when, subject: subj.join('|') };
      });
      return { repo: dir, count: commits.length, commits };
    } catch (e) { return { error: String(e).slice(0, 200) }; }
  },
});
