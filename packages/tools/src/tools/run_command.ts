import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { undoManager } from '@grace/core';
import { registerTool } from '../registry.js';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const LOG_PATH = path.join(ROOT, 'data', 'command-log.jsonl');

// LAYER 1 — HARD DENY: system-damaging / exfiltration patterns. Refused ALWAYS, even with confirm.
// Denylist widened after review: rd/erase, order-independent Remove-Item -Recurse/-Force, and
// rm with r/f flags in any form (single- or double-dash, drive-letter or POSIX path).
const HARD_DENY: RegExp[] = [
  /\brm\s+-[a-zA-Z]*[rf]/i, /\brm\s+--(recursive|force|dir)/i,     // rm -rf / -r / -f / --recursive / --force
  /\brmdir\s+\/s/i, /\brd\s+\/s/i, /\bdel\s+\/[sqf]/i, /\berase\b/i, // Windows recursive/force delete + aliases
  /\b(remove-item|ri)\b[\s\S]*-recurse/i,                          // PowerShell recursive delete, any flag order
  /\bformat\b/i, /\bdiskpart\b/i, /\bmkfs\b/i, /\bdd\s+if=/i,
  /\bshutdown\b/i, /\b(restart|stop)-computer\b/i, /\breg\s+delete/i,
  /:\s*\(\s*\)\s*\{[\s\S]*\}\s*;/,                                  // fork bomb
  /\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(bash|sh|iex|invoke-expression|powershell|pwsh)/i,
  /\b(iex|invoke-expression)\b/i, /-e(nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{40,}/i,
  /\b(cipher|sdelete|takeown)\b/i, /\bnet\s+user\b[\s\S]*\/(add|delete)/i, /\bicacls\b[\s\S]*\/grant/i,
];

// LAYER 2 — read-only verbs that may run UNATTENDED (no confirmation) — matched PER SEGMENT.
const READONLY_RE = /^\s*(ls|dir|cat|type|echo|pwd|cd|whoami|hostname|date|where|which|tree|findstr|grep|head|tail|wc|sort|tasklist|systeminfo|ver|env|set|printenv|node -v|node --version|py --version|python(3)? --version|npm (ls|list|-v|--version|run test|test)|tsc( -b)?( --noEmit)?|git (status|log|diff|show|branch|remote|rev-parse|describe|tag|config --get)|docker (ps|images|info|version)|gh (run list|pr list|repo view|auth status))\b/i;

// Shell control that can hide a SECOND command or redirect I/O behind a read-only prefix.
// A command is only "read-only" (auto-run) if EVERY chained segment is read-only and it does
// no redirection / command-substitution. This closes the `echo x & del important.docx` bypass.
const REDIRECT_RE = /[<>]/;                             // file redirection — a write, never auto-run
const SUBST_RE = /`|\$\(/;                              // command substitution — can embed anything
const CHAIN_SPLIT_RE = /\s*(?:&&|\|\||[|;&])\s*/;       // &&  ||  |  ;  &  (single or double)

function classifyReadOnly(command: string, cwdInsideRepo: boolean): boolean {
  if (REDIRECT_RE.test(command) || SUBST_RE.test(command)) return false;
  const segs = command.split(CHAIN_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0 || !segs.every((seg) => READONLY_RE.test(seg))) return false;
  // `npm test` / `tsc` execute project-defined scripts — only safe to auto-run inside Grace's own repo.
  if (/\b(npm\s+(run\s+)?test|tsc)\b/i.test(command) && !cwdInsideRepo) return false;
  return true;
}

function underDir(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

registerTool({
  name: 'run_command',
  description: 'Run a shell command on Mikkel\'s machine. SAFE-GUARDED: destructive/system commands are hard-blocked; read-only commands run directly; anything else needs Mikkel\'s confirmation (returns needs_confirmation:true so you ASK first, then re-call with confirm:true). Use for builds, tests, git, scripts, dev tasks. Never guess-run something risky.',
  params: {
    command: { type: 'string', description: 'the command line to run', required: true },
    cwd: { type: 'string', description: 'working directory (default: home; must be under home or the Grace repo)' },
    confirm: { type: 'boolean', description: 'set true ONLY after Mikkel has explicitly approved a non-read-only command' },
  },
  async run(args) {
    const command = String(args.command ?? '').trim();
    if (!command) return { error: 'command is required' };

    // Layer 1: hard deny.
    for (const re of HARD_DENY) {
      if (re.test(command)) return { error: `Refused: this command matches a hard-blocked destructive/system pattern and will NOT run. (${command.slice(0, 80)})`, blocked: true };
    }

    // cwd gate: under home or the Grace repo only. Compare with a separator so a sibling dir
    // like C:\Users\mikkel can't pass the C:\Users\mikke gate (prefix-escape fix).
    const home = path.resolve(os.homedir());
    const cwd = path.resolve(String(args.cwd ?? home));
    const cwdInsideRepo = underDir(cwd, ROOT);
    if (!underDir(cwd, home) && !cwdInsideRepo) return { error: `Refused: cwd ${cwd} is outside your home folder and the Grace repo.` };
    if (!fs.existsSync(cwd)) return { error: `cwd does not exist: ${cwd}` };

    // Layer 2: confirmation gate for anything not clearly read-only. A command is only read-only if
    // EVERY chained segment is read-only and it does no redirection/substitution (chaining-bypass fix).
    const readOnly = classifyReadOnly(command, cwdInsideRepo);
    if (!readOnly && args.confirm !== true) {
      return {
        needs_confirmation: true,
        command, cwd,
        note: 'This is not a read-only command. Tell Mikkel exactly what it will run and ask him to confirm; only then re-call run_command with confirm:true.',
      };
    }

    // Log every execution (audit) + note it for undo history (external effects aren't auto-reversible).
    try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), command, cwd, confirmed: !readOnly }) + '\n'); } catch { /* best-effort */ }
    if (!readOnly) undoManager.note(`ran command: ${command.slice(0, 100)}`);

    try {
      const out = execSync(command, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' });
      const text = String(out);
      return { ok: true, command, cwd, output: text.length > 12000 ? text.slice(0, 12000) + '\n…[truncated]' : text };
    } catch (e: any) {
      const stdout = e?.stdout ? String(e.stdout) : '';
      const stderr = e?.stderr ? String(e.stderr) : '';
      return { ok: false, command, cwd, exitCode: e?.status ?? null, output: (stdout + stderr).slice(0, 12000) || String(e).slice(0, 400) };
    }
  },
});
