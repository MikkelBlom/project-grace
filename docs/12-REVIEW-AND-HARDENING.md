# Grace — Adversarial review & hardening (2026-07-20)

A 6-agent adversarial review swept the code added across the big feature push (security
foundations, integrations, the ~35 utility tools, core subsystems) plus two research spikes
(local audio intelligence; HUD + expressive TTS). This records what it found, what was fixed,
and what is deliberately deferred. Regression tests for the security-critical logic live in
`test/pure.test.mjs` (now 13 unit tests).

## Fixed — security (the two criticals first)

1. **run_command chaining bypass (CRITICAL).** The read-only classifier only matched a whitelisted
   verb at the *start* of the string while `execSync` ran the whole line through a shell, so
   `echo x & del important.docx` was classified read-only and ran unattended. Now a command is
   read-only only if **every** chained segment is read-only and it does no redirection/command-
   substitution. Hard-deny widened (rd/erase, order-independent `Remove-Item -Recurse/-Force`, rm
   with r/f in any form). `npm test`/`tsc` only auto-run inside Grace's own repo. Logic extracted to
   `packages/tools/src/lib/commandSafety.ts` and unit-tested against every bypass.
2. **Undo-stack poisoning → sandbox escape (CRITICAL).** `data/` wasn't blocked by `isGraceOwnSource`,
   so the file tools could author `data/undo-stack.json`, and `reverse()` trusted it — driving
   arbitrary-path writes/deletes. Now `data/`+`config/` are blocked from the file tools, and
   `reverse()` re-validates every path under home (backups under the backup dir) before touching it.
3. **Undo false-success.** A silently-failed backup still recorded `reversible:true`; undo then
   no-oped but reported success while the original was gone. `reversible` now reflects backup
   success, and `reverse()` throws (→ `ok:false`) when it can't actually restore.
4. **Undo move-overwrite.** `move_file` over an existing file destroyed it unrecoverably; the move
   entry now backs up the clobbered destination and restores it on undo.
5. **Vault clobber.** A decrypt failure (wrong `GRACE_VAULT_KEY` / corruption) returned `{}`, and the
   next `set()` overwrote all secrets. `load()` now throws on a present-but-undecryptable file so
   `set/delete` refuse to clobber; `get()` degrades to undefined (reads don't crash).
6. **Vault hardening.** Random per-vault salt (was a global constant → offline-brute-forceable
   default-key vault); a stored value now wins over `GRACE_<KEY>` env (no stale-env shadowing).
7. **Home-gate prefix escape.** `startsWith(home)` let `C:\Users\mikkel` pass a `C:\Users\mikke`
   gate; all six file tools + run_command now compare with a separator.
8. **Gmail CRLF header-injection.** `to`/`subject` are stripped of control chars and the recipient is
   validated as a single address, so an injected `\r\nBcc:` can't hide a recipient in a draft.
   (The never-sends invariant itself was confirmed to HOLD — no send endpoint is ever called.)
   Extracted to `lib/emailHeader.ts` + tested.
9. **inject_to_terminal.** `enter:false` still executed lines via embedded `\n → {ENTER}`; newlines
   are now collapsed to spaces when not pressing Enter, making the `willPressEnter:false` preview honest.

## Fixed — correctness / robustness

- **Google auth:** 401 refresh-and-retry (a server-invalidated token no longer wedges every call for
  up to an hour) + in-flight de-dup so a batched Calendar+Gmail turn fires one refresh.
- **HA `ha_call`:** `domain`/`service` restricted to `[a-z0-9_]` (URL-path integrity).
- **MCP stdio on Windows:** `resolveCommand()` walks PATH×PATHEXT so `npx`/`npm` servers start
  (they're `.cmd`; `spawn` with `shell:false` was ENOENT), keeping shell:false (no arg injection).
- **search_content:** strips `g/y` regex flags (stateful `.test()` was skipping matches).
- **find_duplicates:** streams file hashes (flat memory; processes >2 GiB files that were silently dropped).
- **read_document:** reads a bounded 4 MB prefix (was loading whole 800 MB files, blocking the loop).
- **research_kb:** Unicode tokenizer (Danish letters were shredding query terms).
- **weather_forecast:** checks `res.ok` + array shapes before use.
- **GraceCore watchdog:** now an *idle* heartbeat re-armed on `llm:thinking`/`tool:result` (a fixed
  240s cap fired mid-turn on long research turns and let a second turn start concurrently).
- **stt:heard handler** wrapped so a rejected await can't strand `isProcessing=true`.
- **Background-task loop** bounds fed-back tool output (24k/result, 48k total) like the main loop
  (128000/result overflowed `num_ctx` and truncated the task system prompt).
- **isTrivialChat** full-matches `(…)$` so `ja slet den fil` / `yes do it` confirmations no longer
  route to the weaker fast model.
- **research verify** uses `num_ctx 131072` to match the main loop (a different value reloaded the
  model mid-turn and wiped the prefix cache — the dominant latency source).
- **semanticMemory.fetchJson** respects a caller signal (embed's 20s was forced to 10s, aborting the
  slow off-GPU embedder); journal + notification-center flush on process teardown; the `mission`
  namespace is included in default recall; nested fs-index roots no longer double-index; fs-index
  rebuild is capped at 90s under continuous activity.
- **focusTimer.extend()** re-asserts `active` (clearTimer had cleared it → status/stop reported a
  live session as dead).
- **scheduler** reschedules recurring reminders from `dueAt` (no drift), coalesces a due-burst into
  one utterance, and gives each fire a unique sessionId.

## Deferred (need a live test or a product decision — see `known-issues.md`)

- **Concurrent-turn shared OllamaLLM state (#8).** A fire-and-forget mission runs while GraceCore is
  "listening," so a barge-in turn shares instance fields (`currentAbort`, `lastToolContext`). The fix
  is a per-run `AbortController` / cancel token — a real refactor best done with a live mic to test
  barge-in, not blind.
- **Chroma `/api/v1` vs v2.** `heartbeat()` accepts a v2-only server but ops hit `/api/v1`, so recall
  can silently degrade to local-only while telemetry says "chroma." Needs a live Chroma to pin the
  version. (Chroma is off by default when Docker isn't running, so inert today.)
- **MCP threat model.** `mcp_add_server`+`mcp_call` let the model register and spawn arbitrary local
  executables / reach arbitrary hosts (SSRF). shell:false removes injection, but spawning new exes
  from model-driven input should gate behind explicit confirmation or an allowlist — a product call.
- **Vault default key.** With `GRACE_VAULT_KEY` unset the key is machine-derived (guessable). The salt
  is now random, but set `GRACE_VAULT_KEY` for real at-rest security. (Documented, by design.)
