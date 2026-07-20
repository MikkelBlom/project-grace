// ─────────────────────────────────────────────────────────────────────────────
// run_command safety policy — kept as a pure, dependency-free module so it can be unit-tested
// exhaustively (the classification is the whole security boundary). run_command.ts imports these.
//
// Two layers:
//   1. HARD_DENY  — destructive/system/exfiltration patterns. Refused ALWAYS, even with confirm.
//   2. read-only  — may run UNATTENDED (no confirmation). A command is read-only ONLY if every
//      chained segment is a read-only verb AND it does no redirection/command-substitution.
//      Everything else needs Mikkel's explicit confirmation.
// ─────────────────────────────────────────────────────────────────────────────

// LAYER 1 — hard deny. Widened after review: rd/erase, order-independent Remove-Item -Recurse/-Force,
// and rm with r/f flags in any form (single/double dash, drive-letter or POSIX path).
export const HARD_DENY: RegExp[] = [
  /\brm\s+-[a-zA-Z]*[rf]/i, /\brm\s+--(recursive|force|dir)/i,
  /\brmdir\s+\/s/i, /\brd\s+\/s/i, /\bdel\s+\/[sqf]/i, /\berase\b/i,
  /\b(remove-item|ri)\b[\s\S]*-recurse/i,
  /\bformat\b/i, /\bdiskpart\b/i, /\bmkfs\b/i, /\bdd\s+if=/i,
  /\bshutdown\b/i, /\b(restart|stop)-computer\b/i, /\breg\s+delete/i,
  /:\s*\(\s*\)\s*\{[\s\S]*\}\s*;/,
  /\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(bash|sh|iex|invoke-expression|powershell|pwsh)/i,
  /\b(iex|invoke-expression)\b/i, /-e(nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{40,}/i,
  /\b(cipher|sdelete|takeown)\b/i, /\bnet\s+user\b[\s\S]*\/(add|delete)/i, /\bicacls\b[\s\S]*\/grant/i,
];

// LAYER 2 — read-only verbs, matched PER SEGMENT.
export const READONLY_RE = /^\s*(ls|dir|cat|type|echo|pwd|cd|whoami|hostname|date|where|which|tree|findstr|grep|head|tail|wc|sort|tasklist|systeminfo|ver|env|set|printenv|node -v|node --version|py --version|python(3)? --version|npm (ls|list|-v|--version|run test|test)|tsc( -b)?( --noEmit)?|git (status|log|diff|show|branch|remote|rev-parse|describe|tag|config --get)|docker (ps|images|info|version)|gh (run list|pr list|repo view|auth status))\b/i;

const REDIRECT_RE = /[<>]/;                         // file redirection — a write, never auto-run
const SUBST_RE = /`|\$\(/;                           // command substitution — can embed anything
const CHAIN_SPLIT_RE = /\s*(?:&&|\|\||[|;&])\s*/;    // &&  ||  |  ;  &

/** True if the command matches any hard-deny pattern (refused even with confirm). */
export function isHardDenied(command: string): boolean {
  return HARD_DENY.some((re) => re.test(command));
}

/**
 * True only if the command may run UNATTENDED: every chained segment is a read-only verb and there
 * is no redirection or command substitution. Closes the `echo x & del file` chaining bypass, where
 * a read-only prefix used to whitelist an entire destructive line.
 */
export function classifyReadOnly(command: string, cwdInsideRepo: boolean): boolean {
  if (REDIRECT_RE.test(command) || SUBST_RE.test(command)) return false;
  const segs = command.split(CHAIN_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0 || !segs.every((seg) => READONLY_RE.test(seg))) return false;
  // npm test / tsc execute project-defined scripts — only safe to auto-run inside Grace's own repo.
  if (/\b(npm\s+(run\s+)?test|tsc)\b/i.test(command) && !cwdInsideRepo) return false;
  return true;
}
