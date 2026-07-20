import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { registerTool } from '../registry.js';

const OLLAMA_URL = process.env.GRACE_OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.GRACE_LLM_MODEL ?? 'gemma4:26b';
const MAX_DIFF_CHARS = 12_000;

function isRepo(dir: string): boolean { return fs.existsSync(path.join(dir, '.git')); }

// Draft a commit message from the current diff via the local LLM. Never commits — just suggests.
registerTool({
  name: 'generate_commit_msg',
  description: 'Suggest a git commit message (imperative title + short body) from the staged diff (falls back to the unstaged diff) of a repo. Does NOT commit anything. Use when Mikkel wants help writing a commit message.',
  params: {
    path: { type: 'string', description: 'the repo folder (default: current working directory)' },
  },
  async run(args) {
    const dir = path.resolve(String(args.path ?? process.cwd()));
    if (!isRepo(dir)) return { error: `not a git repo: ${dir}` };

    let diff = '';
    let staged = true;
    try {
      diff = execFileSync('git', ['diff', '--staged'], { cwd: dir, timeout: 8000, maxBuffer: 32 * 1024 * 1024 }).toString();
      if (!diff.trim()) {
        staged = false;
        diff = execFileSync('git', ['diff'], { cwd: dir, timeout: 8000, maxBuffer: 32 * 1024 * 1024 }).toString();
      }
    } catch (e) { return { error: String(e).slice(0, 200) }; }

    if (!diff.trim()) return { error: 'no changes to describe (nothing staged or modified)' };

    let truncated = false;
    if (diff.length > MAX_DIFF_CHARS) { diff = diff.slice(0, MAX_DIFF_CHARS); truncated = true; }

    const prompt = `You are writing a git commit message for the following diff.
Output an imperative one-line title (max ~72 chars, no trailing period), then a blank line, then a short body (1-3 sentences) explaining what changed and why.
Do NOT wrap in quotes or code fences. Do NOT invent changes not shown in the diff.${truncated ? '\n(The diff was truncated; summarise what is visible.)' : ''}

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
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return { error: `Ollama HTTP ${res.status}` };
      const d = (await res.json()) as { response?: string };
      const message = (d.response ?? '').trim();
      if (!message) return { error: 'LLM returned an empty message' };
      return { repo: dir, source: staged ? 'staged' : 'unstaged', truncated, message };
    } catch (e) { return { error: String(e) }; }
  },
});
