import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { registerTool } from '../registry.js';

const OLLAMA_URL = process.env.GRACE_OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.GRACE_LLM_MODEL ?? 'gemma4:26b';
const MAX_DIFF_CHARS = 14_000;

function isRepo(dir: string): boolean { return fs.existsSync(path.join(dir, '.git')); }

// Local, offline code review of a diff via the LLM. Read-only — changes nothing.
registerTool({
  name: 'code_review',
  description: 'Ask the local LLM for a concise code review of a repo diff (correctness bugs, risks, quick cleanups). Reviews the unstaged diff by default, or the staged diff with staged=true. Use when Mikkel wants feedback on changes before committing.',
  params: {
    path: { type: 'string', description: 'the repo folder (default: current working directory)' },
    staged: { type: 'boolean', description: 'review the staged diff instead of the working-tree diff (default false)' },
  },
  async run(args) {
    const dir = path.resolve(String(args.path ?? process.cwd()));
    if (!isRepo(dir)) return { error: `not a git repo: ${dir}` };
    const staged = args.staged === true || args.staged === 'true';

    let diff = '';
    try {
      const argv = staged ? ['diff', '--staged'] : ['diff'];
      diff = execFileSync('git', argv, { cwd: dir, timeout: 8000, maxBuffer: 32 * 1024 * 1024 }).toString();
    } catch (e) { return { error: String(e).slice(0, 200) }; }

    if (!diff.trim()) return { error: staged ? 'no staged changes to review' : 'no working-tree changes to review' };

    let truncated = false;
    if (diff.length > MAX_DIFF_CHARS) { diff = diff.slice(0, MAX_DIFF_CHARS); truncated = true; }

    const prompt = `You are a senior engineer doing a concise code review of the following git diff.
Focus on: correctness bugs, edge cases, security or data-loss risks, and quick cleanups. Skip style nitpicks.
Be brief and specific — reference the code you mean. If it looks solid, say so plainly.${truncated ? '\n(The diff was truncated; review only what is shown.)' : ''}

DIFF:
${diff}`;

    try {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL, prompt,
          stream: false, think: false, options: { temperature: 0.2 }, keep_alive: -1,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) return { error: `Ollama HTTP ${res.status}` };
      const d = (await res.json()) as { response?: string };
      const review = (d.response ?? '').trim();
      if (!review) return { error: 'LLM returned an empty review' };
      return { repo: dir, source: staged ? 'staged' : 'unstaged', truncated, review };
    } catch (e) { return { error: String(e) }; }
  },
});
