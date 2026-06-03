# Generic implementation prompt (paste into Antigravity / Copilot / etc.)

Fill in **TASK** on the first line, then hand the whole block to the agent. The rest is generic.

---

```
TASK: <what to build — e.g. "Implement the list_dir tool", or any item from ROADMAP.md>

You are implementing ONE feature in the "Grace" repo — a 100% local voice assistant
(TypeScript monorepo + Python servers). Work on a branch: feat/<short-name>.

STEP 1 — Read these fully before coding:
  - docs/architecture.md      (layout, EventBus flow, the OllamaLLM tool loop, conventions)
  - docs/adding-tools.md      (exact steps + rules for tools — most tasks ARE a tool)
  - ROADMAP.md                (find the entry for TASK; note its spec/intent)
  - docs/working-with-other-ai.md  (the workflow + hard constraints + self-validation checklist)

STEP 2 — Implement TASK exactly per those docs. Most tools go in
  packages/tools/src/index.ts via registerTool({ name, description, params, run }).
  Keep it focused: one feature, minimal diff, no unrelated changes.

HARD RULES:
  - 100% local for AI/models. Tools may call free no-key public APIs for INFO (weather/web) only.
  - Tools return { ...data } or { error } for EXPECTED failures (don't throw); results must be
    small + JSON-serializable; wrap network calls in AbortSignal.timeout(ms).
  - Dangerous actions (write/delete/run) are default-deny and gated to the user's home folder.
  - Do NOT break the build or touch the tsc -b / npm-workspace wiring unless the task is about that.

STEP 3 — VALIDATE before claiming done (paste the evidence, don't just assert):
  - npm run build  →  must be exit 0 (paste the tail).
  - Headless test: write a temp .mjs that does
        import * as t from './packages/tools/dist/index.js'
    then console.log(t.listTools()) and await t.runTool('<name>', {...}) for a happy path AND a
    bad-input path; run it (Ollama on :11434 if the model is involved); paste output; delete the temp file.
  - If the model must CHOOSE the tool, add a quick Ollama sim (model gemma4:26b, think:false) that
    sends a user message and shows it emits the right tool JSON.

STEP 4 — Commit small. Message = imperative title + 1-3 lines of why. End with:
        Co-Authored-By: <your model name> <noreply@example.com>

STEP 5 — Report back in EXACTLY this format so it can be validated:
        Item:        <roadmap entry>
        Branch/commit: <hash>
        What changed: <1-3 lines>
        Validation:  <build result + test output>
        Not tested:  <what + why>
        Open questions: <if any>

If something is ambiguous, pick the simplest correct option and note it. Stay in scope.
```

---

After the agent reports back, paste its "Report back" block to Claude — Claude rebuilds, re-runs
the test, checks the guardrails (build green, {error} not throws, local-only, no broken event
contracts), and merges or returns precise fixes.
