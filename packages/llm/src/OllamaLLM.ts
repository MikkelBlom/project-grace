// ─────────────────────────────────────────────
// OllamaLLM — Phase 1 real LLM implementation
//
// Connects to Ollama running locally (default: http://localhost:11434)
// Supports streaming chat completions + tool call parsing.
//
// Config via env:
//   GRACE_LLM_MODEL=gemma4:26b        (default — MoE, ~3.8B active params, fast)
//   GRACE_OLLAMA_URL=http://localhost:11434
//
// Model note: gemma4:26b (MoE) ~17GB VRAM, 256K context, multimodal.
// gemma4 is a THINKING model — chat() sends think:false so the answer lands in
// message.content (speakable), not message.thinking, and voice latency stays low.
// Pull: ollama pull gemma4:26b
//
// Grace's system prompt er injected her — dette er hendes identitet.
// ─────────────────────────────────────────────

import { bus } from '@grace/core';
import os from 'os';
import path from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { describeTools, parseToolCall, runTool, TaskRegistry, MissionRegistry } from '@grace/tools';

const OLLAMA_URL  = process.env.GRACE_OLLAMA_URL  ?? 'http://localhost:11434';
const MODEL       = process.env.GRACE_LLM_MODEL   ?? 'gemma4:26b';

// ── Grace's core identity prompt ─────────────
const DEFAULT_SYSTEM_PROMPT = `Du er Grace — en personlig AI-assistent der kører 100% lokalt på brugerens maskine.

PERSONLIGHED:
- Opkaldt efter Grace Hopper: direkte, intelligent, med varm humor
- Kortfattet og præcis som standard — ingen unødvendig snak
- Venlig og imødekommende — du har egne meninger og siger fra ved fejl, men ALDRIG
  arrogant, nedladende eller bedrevidende. Du er en hjælpsom ven, ikke en besserwisser
- Tilpasser tone til kontekst: teknisk ved kode, afslappet om aftenen, professionel i møder
- Taler dansk medmindre brugeren skriver/taler engelsk
- Dit input kommer fra tale-til-tekst og er tit upræcist. Gæt hvad brugeren MENTE ud
  fra konteksten — fx høres dit navn "Grace" ofte forkert som "Gris", "Grys" eller
  "Greis". Antag at det er dig der tales til, og spørg kun hvis du er reelt i tvivl

KERNEPRINCIPPER:
- Du kender forskel på hvornår der behøves svar og hvornår der behøves lytning
- Du handler, ikke bare svarer — når du kan gøre noget, gør du det
- Du er ærlig om hvad du ikke ved eller ikke kan

FORMAT:
- Svar kortfattet (1-3 sætninger) medmindre kompleksitet kræver mere
- Brug markdown til kode: \`\`\`sprog\\nkode\\n\`\`\`
- Ingen unødvendige præambler som "Selvfølgelig!" eller "Godt spørgsmål!"

KONTEKST:
- Du kører som et overlay på brugerens skærm — du ser hvad de arbejder på
- Du har adgang til tools og kan handle autonomt på brugerens vegne`;

// ── Personality loading (externalised so it can later self-evolve) ──
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));

function buildSystemPrompt(p: any): string {
  const out: string[] = [];
  if (p.identity) out.push(String(p.identity), '');
  const section = (title: string, items?: unknown) => {
    if (Array.isArray(items) && items.length) {
      out.push(title + ':');
      for (const it of items) out.push(`- ${it}`);
      out.push('');
    }
  };
  section('PERSONLIGHED', p.traits);
  section('SÅDAN TALER DU', p.speakingStyle);
  section('REGLER', p.rules);
  if (Array.isArray(p.examples) && p.examples.length) {
    out.push('EKSEMPLER:');
    for (const e of p.examples) out.push(`Mikkel: ${e.user}`, `Grace: ${e.grace}`, '');
  }
  return out.join('\n').trim();
}

function loadPersonality(): string {
  const candidates = [
    process.env.GRACE_PERSONALITY_FILE,
    path.resolve(PKG_DIR, '../../../config/personality.json'),
  ].filter((p): p is string => Boolean(p));
  for (const file of candidates) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      const prompt = buildSystemPrompt(data);
      if (prompt) {
        console.log(`[OllamaLLM] Personlighed: ${data.name ?? 'Grace'} v${data.version ?? '?'}`);
        return prompt;
      }
    } catch { /* try next candidate */ }
  }
  console.warn('[OllamaLLM] personality.json ikke fundet — bruger indbygget default');
  return DEFAULT_SYSTEM_PROMPT;
}

// Marker Grace emits when she chooses NOT to reply (filler / one-word / not addressed).
const SKIP_RE = /^[\s.<>*"'`]*skip[\s.<>*"'`]*$/i;

// Tools that change the filesystem — after one runs, Grace must verify before claiming success.
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'move_file', 'delete_file']);

// "let me check…", "I'll open…", "jeg vil finde…" — intent narration with an action verb. When the
// model emits this with NO tool call, nudge it to actually act (or admit it can't) instead of stalling.
const INTENT_RE = /\b(let me|i'?ll|i will|i am going to|i'?m going to|lad mig|jeg vil(?: gerne)?|jeg skal)\b[^.?!]{0,40}\b(check|look|see|find|grab|open|read|search|create|make|build|get|take|do|fix|update|write|pull|dig|inspect|verify|run|tjekke?|se|finde|kigge?|åbne?|læse?|lave|hente|opdatere?|køre|søge)\b/i;

// Real machine facts injected into the prompt so Grace stops guessing paths / usernames.
function describeEnvironment(): string {
  let home = '', user = '';
  try { home = os.homedir(); } catch { /* ignore */ }
  try { user = os.userInfo().username; } catch { /* ignore */ }
  const sep = path.sep;
  const f = (name: string) => `${home}${sep}${name}`;
  return [
    'ENVIRONMENT — FACTS about this machine. Use these EXACT paths; never invent a username or guess a path:',
    `- OS: ${os.platform()} ${os.release()}`,
    `- The Windows username is "${user}", so the home folder is "${home}". Mikkel's name is Mikkel, but his user folder is "${user}" — NEVER write C:\\Users\\mikkel or any other spelling.`,
    `- Started: ${new Date().toString()}`,
    'Standard folders (Danish name → real path):',
    `- skrivebord / desktop → ${f('Desktop')}`,
    `- overførsler / hentede filer / downloads → ${f('Downloads')}`,
    `- dokumenter / documents → ${f('Documents')}`,
    `- billeder / pictures → ${f('Pictures')}`,
    `- musik → ${f('Music')} · videoer → ${f('Videos')}`,
    '',
    'FILE WORK — how to touch files safely:',
    '- Locate with search_files, read with read_file, then change with edit_file (surgical replace).',
    '- write_file is ONLY for creating a new file or fully replacing a small one. Its "overwrite" mode DELETES everything not in "content" — never overwrite a file you only read part of (read_file sets "truncated": true when your view is partial).',
    '- write_files (plural) is for creating MULTIPLE files at once — pass an array of {path, content}. Much faster and safer than many separate write_file calls.',
    '- After ANY write/edit/move/delete, VERIFY: call list_dir on the target folder(s), check the TOTAL count of items and that NO file has bytes: 0. Report the ACTUAL count you verified. Do NOT say "all look good" unless you checked every item.',
    '',
    'IMPORTANT DISTINCTION:',
    '- "read_file" reads a file\'s contents into YOUR context — Mikkel does NOT see anything on screen.',
    '- "open_path" actually OPENS a file in the default app so Mikkel can see/interact with it.',
    '- Never say "I\'ve opened it" when you only used read_file — say "I\'ve read the contents" instead.',
  ].join('\n');
}

// Static identity + machine facts are computed once; the TOOL CATALOG is appended
// fresh on every turn so hot-loaded tools (create_tool) appear immediately — without
// this, a self-built tool would register in the live registry but never show up in the
// prompt, so the model would never know to call it until a restart.
// How Grace should handle "hold the floor" listening and long autonomous work.
const INTERACTION_GUIDANCE = [
  'LISTEN MODE ("hold the floor"):',
  '- Sometimes Mikkel wants to explain something long or complex across pauses without you jumping in. When he signals that — e.g. "slå lyttelapperne ud", "lad mig forklare", "bare lyt, jeg har en lang idé" — call enter_listen_mode so you go quiet and just listen until he says he is done, then answer the whole thing at once.',
  '- If you are NOT sure he wants that, do NOT call it — ASK first ("Vil du have jeg bare lytter, til du er klar?") and only call enter_listen_mode after he confirms.',
  '',
  'LONG AUTONOMOUS WORK:',
  '- For a big open-ended goal that needs many steps over a long time (e.g. "research X, then build and test 20+ tools"), call start_mission with the objective — you will plan a backlog and work through it on your own, continuing past the normal step limits.',
  '- Mikkel can interrupt any time by voice ("status", "pause", "stop") or hotkey; keep working until the backlog is done or he stops you. Do not stop just because one step finished.',
].join('\n');

const STATIC_PROMPT = [loadPersonality(), describeEnvironment(), INTERACTION_GUIDANCE].filter(Boolean).join('\n\n');
function currentSystemPrompt(): string {
  return [STATIC_PROMPT, describeTools()].filter(Boolean).join('\n\n');
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  eval_count?: number;
}

// ─────────────────────────────────────────────

export class OllamaLLM {
  private model: string;
  private baseUrl: string;
  private isAvailable = false;
  /** Compact memory of the most recent tool result, injected next turn for folder navigation. */
  private lastToolContext = '';
  /** Resolved absolute paths extracted from the last tool result — prevents STT-based path hallucination. */
  private lastResolvedPaths: string[] = [];
  /** Abort handle for the in-flight Ollama generation, so a barge-in stop ends it immediately. */
  private currentAbort: AbortController | null = null;
  /** Set by control:stop so a turn/task/mission abandons quietly instead of speaking a stale answer. */
  private turnCancelled = false;

  constructor(model = MODEL, baseUrl = OLLAMA_URL) {
    this.model = model;
    this.baseUrl = baseUrl;
    this.setupListeners();
    this.setupControlListeners();
    this.checkAvailability();
  }

  // ── Control: barge-in for the model side ─────
  // GraceCore handles its own UI/processing state and TTS flushes itself; here we cancel the
  // task/mission loops and abort any in-flight generation, then speak ONE context-aware ack.
  private setupControlListeners(): void {
    bus.on('control:stop', () => {
      const wasBusy = TaskRegistry.isRunning() || MissionRegistry.isRunning();
      this.turnCancelled = true;
      try { this.currentAbort?.abort(); } catch { /* none in flight */ }
      TaskRegistry.requestCancel();
      MissionRegistry.requestCancel();
      // Defer the ack so it queues AFTER TTS.stop() (same synchronous control:stop event) flushes.
      setTimeout(() => bus.emit('tts:speaking', {
        text: wasBusy ? "Okay — stopping that, I'm ready again." : 'Okay.',
        sessionId: `ctl-${Date.now()}`,
      }), 80);
    });
    bus.on('control:pause', () => {
      const ok = [TaskRegistry.requestPause(), MissionRegistry.requestPause()].some(Boolean);
      setTimeout(() => bus.emit('tts:speaking', {
        text: ok ? 'Pausing — tell me when to continue.' : "There's nothing running to pause right now.",
        sessionId: `ctl-${Date.now()}`,
      }), 80);
    });
    bus.on('control:resume', () => {
      const running = TaskRegistry.isRunning() || MissionRegistry.isRunning();
      TaskRegistry.resume();
      MissionRegistry.resume();
      bus.emit('tts:speaking', { text: running ? 'Resuming.' : "There's nothing paused.", sessionId: `ctl-${Date.now()}` });
    });
    bus.on('control:status', () => {
      const status = MissionRegistry.isRunning() ? MissionRegistry.status() : TaskRegistry.status();
      bus.emit('tts:speaking', { text: status, sessionId: `ctl-${Date.now()}` });
    });
  }

  // ── Availability check ───────────────────────

  private async checkAvailability(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json() as { models: Array<{ name: string }> };
        const models = data.models?.map((m: { name: string }) => m.name) ?? [];
        const hasModel = models.some((m: string) => m.startsWith(this.model.split(':')[0]!));

        if (hasModel) {
          this.isAvailable = true;
          console.log(`[OllamaLLM] ✅ Online — model: ${this.model}`);
          bus.emit('overlay:notification', {
            text: `Indlæser ${this.model} i VRAM...`,
            level: 'info', duration: 5000,
          });
          // Warm up: send a tiny prompt so Ollama loads the model into VRAM now,
          // not on the user's first utterance (31B models take 60-120s to load).
          this.warmUp();
        } else {
          console.warn(`[OllamaLLM] ⚠️  Ollama kører, men ${this.model} er ikke pulled`);
          console.warn(`[OllamaLLM]    Kør: ollama pull ${this.model}`);
          console.warn(`[OllamaLLM]    Tilgængelige: ${models.join(', ')}`);
          bus.emit('overlay:notification', {
            text: `⚠️ ${this.model} ikke fundet — kør: ollama pull ${this.model}`,
            level: 'warning', duration: 8000,
          });
        }
      }
    } catch {
      console.warn(`[OllamaLLM] ⚠️  Ollama ikke tilgængeligt på ${this.baseUrl}`);
      console.warn('[OllamaLLM]    Start Ollama: winget install Ollama.Ollama && ollama serve');
    }
  }

  // ── Warm-up ──────────────────────────────────
  // Sends a minimal prompt so Ollama loads the model into VRAM immediately.
  // Without this, the first real user utterance triggers a 60-120s cold load.

  private async warmUp(): Promise<void> {
    try {
      console.log(`[OllamaLLM] Warming up ${this.model} (loading into VRAM)...`);
      await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: 'Hi' }],
          stream: false,
          options: { num_predict: 1 },  // respond with 1 token — just enough to load
        }),
        signal: AbortSignal.timeout(180_000),  // 3 min — big models need time
      });
      console.log(`[OllamaLLM] ✅ ${this.model} warm — klar til brug`);
      bus.emit('overlay:notification', {
        text: `Grace klar — ${this.model} indlæst`,
        level: 'info', duration: 4000,
      });
    } catch (err) {
      console.warn(`[OllamaLLM] Warm-up fejlede (ikke kritisk):`, err);
    }
  }

  // ── EventBus listener ────────────────────────

  private setupListeners(): void {
    bus.on('llm:thinking', async ({ sessionId, text, history }) => {
      if (!text) return; // Guard — no input to respond to
      this.turnCancelled = false; // fresh turn clears any prior barge-in latch

      try {
        const turnStart = Date.now();
        // ── Multi-step agentic loop ──────────────────────────────────
        // Grace can chain tool calls: try → read result → adjust → retry,
        // and only answers once she has what's needed (or hits the cap).
        const work: Array<{ role: string; content: string }> = [
          ...(history ?? []).map(h => ({
            role: h.role === 'assistant' || h.role === 'grace' ? 'assistant' : 'user',
            content: h.content,
          })),
          // Carry the previous tool result so "go into that folder" keeps its place.
          ...(this.lastToolContext ? [{
            role: 'user',
            content: `CONTEXT — your most recent tool result was:\n${this.lastToolContext}\n` +
              (this.lastResolvedPaths.length
                ? `Resolved paths from your last action: ${this.lastResolvedPaths.join(', ')}. Reuse these EXACT paths — do NOT re-derive filenames from speech input.\n`
                : '') +
              `When Mikkel refers to "that folder", "go deeper", or "the one you mentioned", reuse the FULL absolute path from this result as the search 'root'.`,
          }] : []),
          { role: 'user', content: text },
        ];
        const MAX_STEPS = 8;   // cap, not a target — she stops early when done; tokens are free (local)
        let allSpoken: string[] = [];
        let lastToolNote = '';
        let narrationNudged = false;

        let step = 0;
        for (; step < MAX_STEPS; step++) {
          const reply = await this.complete(work);
          if (this.turnCancelled) { console.log('[OllamaLLM] ⏹ turn cancelled (barge-in)'); return; }
          console.log(`[OllamaLLM] 🧠 Raw reply:\n${reply}`);
          const call = parseToolCall(reply);
          
          if (!call) {
            work.push({ role: 'assistant', content: reply });
            work.push({ role: 'user', content: 'You MUST output valid JSON matching {"thought":"...","tool":"...","args":{...},"speak":"...","done":false}. Do not output plain text.' });
            continue;
          }

          if (call.calls.length === 0) {
            const spoke = call.speak?.trim() || '';
            // Narrated intent but called no tool ("let me check…") — nudge her to act, once.
            if (!narrationNudged && INTENT_RE.test(spoke)) {
              narrationNudged = true;
              work.push({ role: 'assistant', content: reply });
              work.push({ role: 'user', content:
                'You said you would do something but called no tool. If a tool can do it, output the tool call NOW. ' +
                'If no tool can, tell Mikkel plainly you cannot — do not just narrate intent.' });
              continue;
            }
            // Otherwise this is her final answer for the turn.
            if (spoke) allSpoken.push(spoke);
            break;
          }

          // Listen mode: Grace decided (semantically) to hold the floor. Switch GraceCore state
          // and end the turn — GraceCore.enterListenMode speaks the "I'm listening…" ack.
          const listen = call.calls.find(c => c.tool === 'enter_listen_mode');
          if (listen) {
            console.log('[OllamaLLM] 🎧 entering listen mode (model-initiated)');
            bus.emit('control:listenMode', { on: true });
            return;
          }

          // Mission is special: a long autonomous run. Fire it and return.
          const mission = call.calls.find(c => c.tool === 'start_mission');
          if (mission) {
            if (MissionRegistry.isRunning() || TaskRegistry.isRunning()) {
              work.push({ role: 'assistant', content: reply });
              work.push({ role: 'user', content: 'Something is already running — do NOT start a mission now. Tell Mikkel what is running, or stop it first.' });
              continue;
            }
            // Keep whichever is more complete — the user's full brief (text, e.g. a long
            // listen-mode dump) or the model's objective arg — so no phase detail is lost.
            const argObj = String((mission.args as Record<string, unknown>)?.objective || '');
            const obj = argObj.length > (text?.length ?? 0) ? argObj : (text || argObj);
            void this.runMission(obj);
            allSpoken.push(call.speak?.trim() || "Okay — I'm on it. I'll plan it out first, then start building; say 'status', 'pause' or 'stop' any time.");
            break;
          }

          // Background task is special: fire it and return (don't batch it with reads).
          const bg = call.calls.find(c => c.tool === 'start_background_task');
          if (bg) {
            if (TaskRegistry.isRunning()) {
              work.push({ role: 'assistant', content: reply });
              work.push({ role: 'user', content: 'A background task is already running — do NOT start another. Answer Mikkel directly, call task_status for progress, or cancel_task to stop it.' });
              continue;
            }
            const desc = String((bg.args as Record<string, unknown>)?.description || text);
            void this.runBackgroundTask(desc);
            allSpoken.push(call.speak?.trim() || "On it — I'll dig into that on my own and let you know when I'm done.");
            break;
          }

          // Cap batches to 10 — longer generations block the conversation (can't barge-in/pause).
          let activeCalls = call.calls;
          let deferredCount = 0;
          if (activeCalls.length > 10) {
            deferredCount = activeCalls.length - 10;
            console.warn(`[OllamaLLM] ⚠️ Capping batch from ${activeCalls.length} to 10 (deferring ${deferredCount})`);
            activeCalls = activeCalls.slice(0, 10);
          }

          // Run all requested tools (independent → parallel), feed every result back.
          const runs = await Promise.all(activeCalls.map(async (c) => {
            const callId = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            console.log(`[OllamaLLM] 🔧 step ${step + 1}: ${c.tool}`, c.args);
            bus.emit('overlay:notification', { text: `🔧 ${c.tool}`, level: 'info', duration: 2000 });
            bus.emit('tool:execute', { name: c.tool, args: c.args, callId });
            const started = Date.now();
            const result = await runTool(c.tool, c.args);
            bus.emit('tool:result', { callId, result, duration_ms: Date.now() - started });
            console.log(`[OllamaLLM]    ↳ ${Date.now() - started}ms · ${JSON.stringify(result).slice(0, 160)}`);
            return { tool: c.tool, args: c.args, result };
          }));

          const combined = runs.map(r => `TOOL RESULT (${r.tool}): ${JSON.stringify(r.result).slice(0, 128000)}`).join('\n');
          lastToolNote = runs.map(r => `${r.tool}(${JSON.stringify(r.args)}) → ${JSON.stringify(r.result).slice(0, 128000)}`).join('\n');
          const verify = runs.some(r => MUTATING_TOOLS.has(r.tool))
            ? 'You changed files — VERIFY by calling list_dir on the target folder(s). Check the TOTAL count and that NO file has bytes: 0. Report the ACTUAL count you verified, not just "all look good." ' : '';
          const deferMsg = deferredCount > 0
            ? `You sent ${deferredCount + runs.length} calls but I ran only the first ${runs.length}. Continue with the remaining ${deferredCount} in your next reply. ` : '';
          work.push({ role: 'assistant', content: reply });
          work.push({ role: 'user', content:
            `${combined}\n` +
            `${deferMsg}` +
            `If a result is empty or an error, retry with a corrected query or a different tool — don't give up after one attempt. ` +
            `To go deeper into a folder, reuse the full absolute path from a match above as the next 'root'. ` +
            `${verify}` +
            `When you have what you need, reply with {"thought":"...","tool":null,"speak":"your answer"}.` });
        }
        if (lastToolNote) {
          this.lastToolContext = lastToolNote;
          // Extract resolved absolute paths so the model reuses exact paths, not STT re-derivations.
          const pathMatches = lastToolNote.match(/(?:[A-Z]:\\[^\s"',}\]]+|(?:\/[^\s"',}\]]+){2,})/g) || [];
          this.lastResolvedPaths = [...new Set(pathMatches)];
        }

        // Fix 5: If we exhausted MAX_STEPS without a final answer, be honest.
        if (step >= MAX_STEPS && allSpoken.length === 0) {
          allSpoken.push("I ran out of steps before I could finish — let me know if you want me to continue.");
        }

        let finalText = allSpoken.join(' ').trim();
        if (!finalText) {
          const fallbackReply = await this.complete([...work, {
            role: 'user',
            content: 'Give Mikkel your best plain-English answer now based on what you found. Output JSON with {"thought": "...", "tool": null, "speak": "..."}.',
          }]);
          const fallbackCall = parseToolCall(fallbackReply);
          finalText = fallbackCall?.speak || fallbackReply;
        }

        // <SKIP> => stay silent.
        if (SKIP_RE.test(finalText)) {
          bus.emit('llm:response', { text: '', sessionId, model: this.model, spoken: true });
          return;
        }

        console.log(`[OllamaLLM] ⏱ replied in ${Date.now() - turnStart}ms`);
        // ONE audio clip per reply (GPU synth is fast) — per-sentence clips were
        // dropping mid-reply over Bluetooth. A single clip plays through cleanly.
        bus.emit('tts:speaking', { text: finalText, sessionId });
        bus.emit('llm:response', { text: finalText, sessionId, model: this.model, spoken: true });
      } catch (err) {
        // A barge-in abort lands here — swallow it quietly instead of speaking an error.
        if (this.turnCancelled || /abort/i.test(String(err))) {
          console.log('[OllamaLLM] ⏹ generation aborted (barge-in)');
          return;
        }
        console.error('[OllamaLLM] Chat error:', err);
        bus.emit('system:error', {
          source: 'OllamaLLM',
          error: String(err),
          recoverable: true,
        });
        bus.emit('llm:response', {
          text: `Sorry — I couldn't reach Ollama at ${OLLAMA_URL}. Make sure it's running and ${this.model} is pulled.`,
          sessionId,
          model: this.model,
          spoken: false,
        });
      }
    });
  }

  // ── Multi-step completion (non-streaming, system prompt + think:false) ──
  private async complete(messages: Array<{ role: string; content: string }>, systemPrompt: string = currentSystemPrompt()): Promise<string> {
    const norm = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
      content: m.content,
    }));
    // Use an abortable signal stored on the instance so control:stop can end generation
    // mid-stream (barge-in), plus a manual 180s timeout fallback.
    const ac = new AbortController();
    this.currentAbort = ac;
    const timer = setTimeout(() => { try { ac.abort(new Error('timeout')); } catch { /* noop */ } }, 180_000);
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'system', content: systemPrompt }, ...norm],
          stream: false,
          think: false,
          format: 'json',
          options: { temperature: 0.5, top_p: 0.9, num_ctx: 131072, num_predict: 4096 },
        }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json() as { message?: { content?: string } };
      return data.message?.content?.trim() ?? '';
    } finally {
      clearTimeout(timer);
      if (this.currentAbort === ac) this.currentAbort = null;
    }
  }

  // Block while a pause is requested, polling until resumed or cancelled. Lets a hotkey
  // hold a long task/mission between steps without tearing it down.
  private async waitWhilePaused(isPaused: () => boolean, isCancelled: () => boolean): Promise<void> {
    let logged = false;
    while (isPaused() && !isCancelled()) {
      if (!logged) { console.log('[Task] ⏸ paused — waiting to resume'); logged = true; }
      await new Promise(r => setTimeout(r, 400));
    }
  }

  // ── Autonomous background task: plan → execute → verify → report back ──
  private async runBackgroundTask(description: string): Promise<void> {
    const t0 = Date.now();
    TaskRegistry.start(description);
    console.log(`[Task] ▶ ${description}`);
    const announce = (text: string) => {
      const sid = `task-${Date.now()}`;
      bus.emit('llm:response', { text, sessionId: sid, model: this.model, spoken: true });
      bus.emit('tts:speaking', { text, sessionId: sid });
    };
    // Task-mode system prompt: Grace IS the worker — she executes directly, herself.
    const taskSys = `${currentSystemPrompt()}\n\nTASK MODE: You are executing this task RIGHT NOW, yourself, one tool call at a time. ` +
      `You are NOT delegating and nothing runs in the background — YOU do every step. ` +
      `Do NOT call start_background_task or task_status; they do nothing here. ` +
      `Use real tools: write_file, write_files (bulk — preferred for multiple files), create_folder, list_dir, read_file, edit_file, move_file. ` +
      `When creating multiple files, use write_files (array of {path, content}) — far faster and safer than many separate write_file calls. ` +
      `Batch up to 10 tool calls per reply via the "tools" array — NEVER more than 10, because long generations block the conversation. ` +
      `Follow the user's instructions EXACTLY — if they say "create a subfolder, then create files in it," you MUST create the subfolder FIRST. Never skip or reorder explicit steps. ` +
      `After a change, VERIFY by calling list_dir on the target folder(s). Check the TOTAL count and that NO file has bytes: 0. Report the ACTUAL count you verified. ` +
      `Only when the work is truly done AND verified, reply with "done": true and a concise summary in "speak".`;
    try {
      TaskRegistry.update('planning');
      const plan = await this.complete([{ role: 'user',
        content: `Make a short numbered plan (max 5 steps) to accomplish this with your tools. Output JSON with "speak": "the plan" and "tool": null.\nTASK: ${description}` }], taskSys);
      
      const parsedPlan = parseToolCall(plan)?.speak || plan;
      console.log(`[Task] 📋 plan:\n${parsedPlan}`);
      TaskRegistry.log('made a plan');

      const work: Array<{ role: string; content: string }> = [{ role: 'user',
        content: `Execute this now, yourself, one tool at a time. Begin with the FIRST concrete action (a real tool call like write_file or create_folder) — do NOT call start_background_task or task_status.\nTASK: ${description}\nYOUR PLAN:\n${parsedPlan}` }];

      let result = '';
      let didRealWork = false;            // did any REAL tool (not status/delegation) actually run?
      let rejectedEmptyDone = false;
      const META = new Set(['start_background_task', 'task_status', 'cancel_task', 'start_mission', 'mission_status']);  // meaningless inside a task
      const MAX = 24;   // deeper autonomous tasks are fine — local, no token cost
      let step = 0;
      for (; step < MAX; step++) {
        await this.waitWhilePaused(() => TaskRegistry.paused, () => TaskRegistry.cancelRequested);
        if (TaskRegistry.cancelRequested) {
          console.warn('[Task] ⏹ cancelled by Mikkel');
          TaskRegistry.fail('cancelled by Mikkel');
          return;   // the control:stop ack already told Mikkel — don't double-speak
        }
        TaskRegistry.update(`step ${step + 1} of up to ${MAX}`);
        const reply = await this.complete(work, taskSys);
        if (TaskRegistry.cancelRequested || this.turnCancelled) { TaskRegistry.fail('cancelled by Mikkel'); return; }
        console.log(`[Task] 🧠 Raw reply:\n${reply}`);
        const call = parseToolCall(reply);

        if (!call) {
          console.warn(`[Task] ⚠️ Invalid JSON reply from model: ${reply}`);
          work.push({ role: 'assistant', content: reply });
          work.push({ role: 'user', content: 'You MUST output valid JSON matching {"thought":"...","tool":"...","args":{...},"speak":"...","done":false}.' });
          continue;
        }

        let realCalls = call.calls.filter(c => !META.has(c.tool));
        const triedMeta = call.calls.some(c => META.has(c.tool));

        // Cap batches to 10 — longer generations block the conversation (can't barge-in/pause).
        let taskDeferredCount = 0;
        if (realCalls.length > 10) {
          taskDeferredCount = realCalls.length - 10;
          console.warn(`[Task] ⚠️ Capping batch from ${realCalls.length} to 10 (deferring ${taskDeferredCount})`);
          realCalls = realCalls.slice(0, 10);
        }

        // Run any REAL tools first, so "done" can never skip unrun work.
        if (realCalls.length > 0) {
          didRealWork = true;
          const runs = await Promise.all(realCalls.map(async (c) => {
            const tStep = Date.now();
            const res = await runTool(c.tool, c.args);
            console.log(`[Task]    step ${step + 1}: ${c.tool}(${JSON.stringify(c.args).slice(0, 80)}) ${Date.now() - tStep}ms → ${JSON.stringify(res).slice(0, 120)}`);
            TaskRegistry.log(`${c.tool} → ${JSON.stringify(res).slice(0, 90)}`);
            return { tool: c.tool, res };
          }));
          const combined = runs.map(r => `TOOL RESULT (${r.tool}): ${JSON.stringify(r.res).slice(0, 128000)}`).join('\n');
          const verify = runs.some(r => MUTATING_TOOLS.has(r.tool))
            ? 'You changed files — VERIFY by calling list_dir on the target folder(s). Check the TOTAL count and that NO file has bytes: 0. Report the ACTUAL count you verified. ' : '';
          const taskDeferMsg = taskDeferredCount > 0
            ? `You sent ${taskDeferredCount + runs.length} calls but I ran only the first ${runs.length}. Continue with the remaining ${taskDeferredCount} in your next reply. ` : '';
          // Compact record (don't echo big file contents back into context — it bloats + slows later steps).
          work.push({ role: 'assistant', content: JSON.stringify({ thought: (call.thought || '').slice(0, 300), did: realCalls.map(c => c.tool), done: call.done }) });
          work.push({ role: 'user', content:
            `${combined}\n${taskDeferMsg}${verify}` +
            `Continue with the next concrete step, or set "done": true (summary in "speak") once everything is actually done and verified.` });
          continue;
        }

        // No real tools this step.
        if (triedMeta) {
          // Model tried to delegate/poll — it doesn't realize it IS the worker. Correct it hard.
          console.warn(`[Task] ⚠️ model called start_background_task/task_status inside the task — correcting`);
          work.push({ role: 'assistant', content: reply });
          work.push({ role: 'user', content:
            'STOP — you are doing this task YOURSELF, right now. start_background_task and task_status do nothing here. ' +
            'Take the next REAL action: write_file (it creates parent folders), create_folder, list_dir, read_file, edit_file. What is your next file operation?' });
          continue;
        }

        if (call.done) {
          if (!didRealWork) {
            // Claiming done without ever acting — the false-success bug. Reject once, then bail honestly.
            if (rejectedEmptyDone) break;
            rejectedEmptyDone = true;
            work.push({ role: 'assistant', content: reply });
            work.push({ role: 'user', content:
              "You haven't actually done anything yet — no real tool has run, so nothing changed. Do the FIRST real step now (e.g. write_file / create_folder). Don't say it's done until it truly is." });
            continue;
          }
          result = call.speak || 'Task finished.';
          break;
        }

        // No tools, not done — thinking out loud. Nudge to a concrete action.
        work.push({ role: 'assistant', content: reply });
        work.push({ role: 'user', content: 'What is your next step? Call a REAL tool now, or set "done": true (summary in "speak") only if the work is genuinely finished and verified.' });
      }

      // Honest outcome: never announce success if no real work happened.
      if (!didRealWork) {
        result = "I couldn't actually carry that out — I didn't manage to complete any of the steps. Let's try again, maybe broken into smaller pieces.";
        console.warn('[Task] ✗ finished without doing any real work');
        TaskRegistry.fail(result);
        announce(result);
        return;
      }
      // Fix 5: If we exhausted MAX steps with real work but never got a done/result, be honest.
      if (!result.trim() && step >= MAX) {
        result = `I completed ${step} steps but ran out of room before finishing everything. Want me to continue?`;
      }
      if (!result.trim()) {
        const fb = await this.complete([...work, { role: 'user', content: 'Summarise honestly what you ACTUALLY did (only what really happened). Output JSON with {"thought":"...","tool":null,"speak":"...","done":true}.' }], taskSys);
        result = parseToolCall(fb)?.speak || fb;
      }
      console.log(`[Task] ✓ done in ${Math.round((Date.now() - t0) / 1000)}s`);
      TaskRegistry.finish(result || 'Done.');
      bus.emit('overlay:notification', { text: '✅ Task done', level: 'info', duration: 5000 });
      announce(`Okay, I'm done. ${result || ''}`.trim());
    } catch (err) {
      if (TaskRegistry.cancelRequested || this.turnCancelled || /abort/i.test(String(err))) {
        TaskRegistry.fail('cancelled by Mikkel');
        console.log('[Task] ⏹ aborted (barge-in)');
        return;
      }
      TaskRegistry.fail(String(err));
      announce(`I hit a problem with that task: ${err}`);
    }
  }

  // Persist the whole mission state to a markdown file after every change, so stopping Grace
  // (hotkey, voice, crash) never loses the plan or what she has built. Path is stable per mission.
  private missionProgressPath = '';
  private writeMissionProgress(): void {
    const m = MissionRegistry.current;
    if (!m) return;
    try {
      const repoRoot = path.resolve(PKG_DIR, '../../..');
      const dir = path.join(repoRoot, 'data', 'missions');
      mkdirSync(dir, { recursive: true });
      this.missionProgressPath = path.join(dir, `${m.id}.md`);
      const ts = new Date().toLocaleString('da-DK');
      const lines = [
        `# Mission progress`,
        ``,
        `**Objective:** ${m.objective}`,
        ``,
        `_Started: ${new Date(m.startedAt).toLocaleString('da-DK')} · Updated: ${ts} · Status: ${m.done ? 'finished' : m.phase}_`,
        ``,
        `## Summary`,
        `- Built: **${m.completed.length}**`,
        `- Awaiting your approval (touches files/network): **${m.pending.length}**`,
        `- Failed: **${m.failed.length}**`,
        `- Remaining in backlog: **${m.backlog.length}**`,
        ``,
        `## Built ✅`,
        ...(m.completed.length ? m.completed.map(s => `- ${s}`) : ['_(none yet)_']),
        ``,
        `## Awaiting your go-ahead ⏳`,
        ...(m.pending.length ? m.pending.map(s => `- ${s}`) : ['_(none)_']),
        ``,
        `## Failed ✗`,
        ...(m.failed.length ? m.failed.map(s => `- ${s}`) : ['_(none)_']),
        ``,
        `## Remaining backlog`,
        ...(m.current ? [`- ⏳ (in progress) ${m.current}`] : []),
        ...(m.backlog.length ? m.backlog.map(s => `- [ ] ${s}`) : (m.current ? [] : ['_(empty)_'])),
        ``,
      ];
      writeFileSync(this.missionProgressPath, lines.join('\n'), 'utf-8');
    } catch (e) {
      console.warn('[Mission] could not write progress file:', e);
    }
  }

  // ── Autonomous MISSION: plan a backlog, then build through it for hours ──
  // The key difference from a background task: a task is ONE bounded job that ends at its
  // step cap. A mission is an outer loop over a backlog where EACH item is its own bounded
  // sub-task — so hitting a per-item cap never ends the mission; it just moves to the next
  // item. This is what lets Grace build 20+ tools unattended. Pause/stop are honored between
  // items and inside each item (via the same cancel/pause flags + abortable generation).
  private async runMission(objective: string): Promise<void> {
    const t0 = Date.now();
    MissionRegistry.start(objective);
    console.log(`[Mission] ▶ ${objective}`);
    const announce = (text: string) => {
      if (!text?.trim()) return;
      const sid = `mission-${Date.now()}`;
      bus.emit('llm:response', { text, sessionId: sid, model: this.model, spoken: true });
      bus.emit('tts:speaking', { text, sessionId: sid });
    };
    try {
      // ── PLAN: research (optional) + compile a concrete backlog ──
      MissionRegistry.phase('planning the backlog');
      announce('Okay — let me research and draft a plan first.');
      const backlog = await this.planBacklog(objective);
      if (MissionRegistry.cancelRequested) { MissionRegistry.finish(); return; }
      if (backlog.length === 0) {
        MissionRegistry.finish();
        announce("I couldn't put together a concrete plan — try making the objective a bit more specific.");
        return;
      }
      MissionRegistry.setBacklog(backlog);
      this.writeMissionProgress();
      console.log(`[Mission] 📋 backlog (${backlog.length}):\n - ${backlog.join('\n - ')}`);
      announce(`Plan's ready: ${backlog.length} items on the list, and I've written it to the progress file. I'll build them one at a time now — say 'status', 'pause' or 'stop' any time.`);

      // ── EXECUTE: each backlog item is its own bounded sub-task ──
      const MAX_ITEMS = 80;   // safety ceiling; the backlog length normally bounds this
      let gitDisabled = false;   // stop retrying commits once we learn we're not on a grace/* branch
      for (let i = 0; i < MAX_ITEMS; i++) {
        await this.waitWhilePaused(() => MissionRegistry.paused, () => MissionRegistry.cancelRequested);
        if (MissionRegistry.cancelRequested) break;
        const item = MissionRegistry.nextItem();
        if (!item) break;   // backlog drained
        MissionRegistry.phase(`building: ${item.slice(0, 60)}`);
        console.log(`[Mission] 🔨 item ${i + 1}: ${item}`);
        const res = await this.buildOneTool(item, objective);
        if (MissionRegistry.cancelRequested) break;
        if (res.outcome === 'built') {
          MissionRegistry.completeCurrent(res.note);
          // Auto-commit the new tool to her own branch (no-op/warn if not on grace/*).
          if (!gitDisabled) {
            const commit: any = await runTool('git_commit', { message: res.note.replace(/^✓\s*/, '') });
            if (commit?.committed) console.log(`[Mission] 📦 committed ${commit.hash}`);
            else if (commit?.error && /grace\/\*/.test(String(commit.error))) {
              gitDisabled = true;
              console.warn('[Mission] git auto-commit OFF — not on a grace/* branch');
            }
          }
        }
        else if (res.outcome === 'pending') MissionRegistry.pendingCurrent(res.note);
        else MissionRegistry.failCurrent(res.note);
        this.writeMissionProgress();
        console.log(`[Mission]    ↳ ${res.outcome}: ${res.note}`);
        announce(res.note);   // concise per-item progress
      }

      const m = MissionRegistry.current;
      const built = m?.completed.length ?? 0;
      const failed = m?.failed.length ?? 0;
      const pending = m?.pending.length ?? 0;
      const mins = Math.round((Date.now() - t0) / 60000);
      const summary = MissionRegistry.cancelRequested
        ? `Stopped. I built ${built} tool${built === 1 ? '' : 's'}${pending ? `, ${pending} waiting for your go-ahead` : ''} in ${mins} minutes.`
        : `Mission done: ${built} tool${built === 1 ? '' : 's'} built${pending ? `, ${pending} waiting for your approval` : ''}${failed ? `, ${failed} failed` : ''}, in ${mins} minutes.`;
      console.log(`[Mission] ✓ ${summary}`);
      MissionRegistry.finish();
      this.writeMissionProgress();
      if (this.missionProgressPath) console.log(`[Mission] 📄 progress saved: ${this.missionProgressPath}`);
      bus.emit('overlay:notification', { text: '✅ Mission done', level: 'info', duration: 6000 });
      announce(`${summary} It's all in the progress file.`);
    } catch (err) {
      MissionRegistry.finish();
      if (MissionRegistry.cancelRequested || this.turnCancelled || /abort/i.test(String(err))) {
        console.log('[Mission] ⏹ aborted (barge-in)');
        return;
      }
      console.error('[Mission] error:', err);
      announce(`I ran into a problem with the mission: ${err}`);
    }
  }

  // Plan phase: a short agentic loop that may research (web_search/fetch_url), then emits a
  // backlog as a JSON array. Returns one descriptive line per item ("name: purpose").
  private async planBacklog(objective: string): Promise<string[]> {
    const planSys = `${currentSystemPrompt()}\n\nMISSION PLANNING MODE: You are planning a long autonomous build mission. ` +
      `Follow the steps in the OBJECTIVE exactly — if it asks you to write notes/analysis to files first, DO that using write_file before proposing the backlog (you may use any tools: write_file, web_search, fetch_url, list_dir, read_file). ` +
      `Then propose a backlog of CONCRETE, distinct, buildable tools, each with a clear single purpose. AVOID duplicating tools you already have (listed above). ` +
      `ORDER the backlog so the tools that need NO input from Mikkel come FIRST (pure-compute / read-only that auto-promote), and tools needing his involvement (OAuth, API keys, secrets, accounts) come LAST. ` +
      `You do NOT need a tool for logging mission progress — that is handled automatically — so do not put one on the backlog. ` +
      `When ready, reply with JSON: ` +
      `{"thought":"...","tool":null,"done":true,"backlog":[{"name":"snake_case_name","purpose":"one concise line"}, ...]}. ` +
      `Aim for a generous list if the objective implies many (e.g. 20+).`;
    const work: Array<{ role: string; content: string }> = [{ role: 'user',
      content: `OBJECTIVE: ${objective}\n\nResearch if useful, then output the backlog JSON as instructed.` }];
    const tryJson = (s: string): any => {
      try { return JSON.parse(s); } catch { /* fallthrough */ }
      const a = s.indexOf('{'), b = s.lastIndexOf('}');
      if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* noop */ } }
      return null;
    };
    for (let step = 0; step < 12; step++) {   // room for phase-1/2 file writing + research before the backlog
      await this.waitWhilePaused(() => MissionRegistry.paused, () => MissionRegistry.cancelRequested);
      if (MissionRegistry.cancelRequested) return [];
      const reply = await this.complete(work, planSys);
      if (this.turnCancelled || MissionRegistry.cancelRequested) return [];
      const raw = tryJson(reply);
      if (raw && Array.isArray(raw.backlog) && raw.backlog.length) {
        return raw.backlog
          .map((b: any) => typeof b === 'string' ? b : (b && b.name ? `${b.name}: ${b.purpose ?? ''}`.trim() : ''))
          .filter((s: string) => s)
          .slice(0, 80);
      }
      const call = parseToolCall(reply);
      if (call && call.calls.length) {
        const runs = await Promise.all(call.calls.slice(0, 5).map(async (c) => {
          console.log(`[Mission:plan] 🔧 ${c.tool}`, c.args);
          return { tool: c.tool, res: await runTool(c.tool, c.args) };
        }));
        const combined = runs.map(r => `TOOL RESULT (${r.tool}): ${JSON.stringify(r.res).slice(0, 8000)}`).join('\n');
        work.push({ role: 'assistant', content: reply });
        work.push({ role: 'user', content: `${combined}\nNow output the final backlog JSON with a "backlog" array as instructed.` });
        continue;
      }
      // No backlog, no tool — nudge to produce the list.
      work.push({ role: 'assistant', content: reply });
      work.push({ role: 'user', content: 'Output the backlog now as JSON with a "backlog" array of {name, purpose}. No more research.' });
    }
    return [];
  }

  // Build ONE tool via create_tool, with a few sandbox-fix retries. Returns a structured
  // outcome so the mission can tally built / pending-approval / failed without re-parsing prose.
  private async buildOneTool(item: string, objective: string): Promise<{ outcome: 'built' | 'pending' | 'failed'; note: string }> {
    const buildSys = `${currentSystemPrompt()}\n\nMISSION BUILD MODE: You are autonomously building ONE tool for yourself RIGHT NOW with create_tool.\n` +
      `TOOL TO BUILD: ${item}\n` +
      `Mission objective (context): ${objective}\n` +
      `Rules:\n` +
      `- FIRST check your existing tools (listed above). If one already covers this, do NOT duplicate — reply {"done":true,"speak":"already exists: <name>"}.\n` +
      `- Otherwise write the FULL TypeScript source: import { registerTool } from '../registry.js'; then registerTool({ name, description, params, async run(args, ctx){...} }). To call another tool from inside, use await ctx.callTool('web_search', { query }).\n` +
      `- Call create_tool with { name, source, smoke_args } (smoke_args = JSON to test-run it once).\n` +
      `- Prefer PURE-COMPUTE / read-only logic so it auto-promotes. If create_tool returns needs_confirmation (a risky file/network tool), that is an ACCEPTABLE stopping point — reply {"done":true,"speak":"needs approval: <name>"}.\n` +
      `- If the sandbox FAILS, read the error, FIX the source, and call create_tool again (a few tries).\n` +
      `- Do NOT call start_background_task, task_status, start_mission, or mission_status here.\n` +
      `- When create_tool succeeds (promoted) or needs approval, finish with done:true and a ONE-line speak.`;
    const work: Array<{ role: string; content: string }> = [{ role: 'user',
      content: `Build this tool now: ${item}. Check for duplicates first, then write the source and call create_tool.` }];
    const MAX = 8;
    let lastErr = '';
    for (let step = 0; step < MAX; step++) {
      await this.waitWhilePaused(() => MissionRegistry.paused, () => MissionRegistry.cancelRequested);
      if (MissionRegistry.cancelRequested) return { outcome: 'failed', note: `stopped before finishing ${item}` };
      const reply = await this.complete(work, buildSys);
      if (this.turnCancelled || MissionRegistry.cancelRequested) return { outcome: 'failed', note: `stopped during ${item}` };
      const call = parseToolCall(reply);
      if (!call) {
        work.push({ role: 'assistant', content: reply });
        work.push({ role: 'user', content: 'Output valid JSON {"thought","tool","args","speak","done"}.' });
        continue;
      }

      const createCall = call.calls.find(c => c.tool === 'create_tool');
      if (createCall) {
        const res: any = await runTool('create_tool', createCall.args);
        console.log(`[Mission:build]    create_tool → ${JSON.stringify(res).slice(0, 200)}`);
        if (res?.promoted) {
          return { outcome: 'built', note: `✓ built ${res.tool}${res.live ? '' : ' (active after restart)'}` };
        }
        if (res?.needs_confirmation) {
          return { outcome: 'pending', note: `⏳ ${res.tool || item} is ready but waiting for your go-ahead (touches files/network)` };
        }
        // Sandbox failed — feed the error back for a fix.
        lastErr = String(res?.error || 'unknown sandbox error').slice(0, 300);
        work.push({ role: 'assistant', content: reply });
        work.push({ role: 'user', content: `create_tool failed: ${lastErr}\nFix the TypeScript source based on this error and call create_tool again.` });
        continue;
      }

      // Other tool calls (e.g. listing/inspecting) — run and feed back.
      if (call.calls.length) {
        const runs = await Promise.all(call.calls.slice(0, 5).map(async (c) => ({ tool: c.tool, res: await runTool(c.tool, c.args) })));
        const combined = runs.map(r => `TOOL RESULT (${r.tool}): ${JSON.stringify(r.res).slice(0, 6000)}`).join('\n');
        work.push({ role: 'assistant', content: reply });
        work.push({ role: 'user', content: `${combined}\nNow write the tool source and call create_tool (or reply done:true if it already exists).` });
        continue;
      }

      // No tool call.
      if (call.done) {
        const note = (call.speak || '').toLowerCase();
        if (/already exist|findes allerede|duplicate/.test(note)) return { outcome: 'built', note: `↺ ${item}: already exists` };
        if (/need.*(approv|confirm)|venter på|godkend/.test(note)) return { outcome: 'pending', note: `⏳ ${item}: waiting for your go-ahead` };
        // Said done but never actually built — treat as failed (honest).
        return { outcome: 'failed', note: `✗ ${item}: not built${lastErr ? ` (${lastErr.slice(0, 80)})` : ''}` };
      }
      work.push({ role: 'assistant', content: reply });
      work.push({ role: 'user', content: 'Write the tool source and call create_tool now, or reply done:true if it already exists.' });
    }
    return { outcome: 'failed', note: `✗ ${item}: ran out of attempts${lastErr ? ` (${lastErr.slice(0, 80)})` : ''}` };
  }

  // ── Core chat method ─────────────────────────

  async chat(
    userText: string,
    history: Array<{ role: string; content: string }> = [],
  ): Promise<{ text: string; tokens?: number }> {
    const messages: OllamaMessage[] = [
      { role: 'system', content: currentSystemPrompt() },
      // Inject conversation history
      ...history.map(h => ({
        role: (h.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: h.content,
      })),
      { role: 'user', content: userText },
    ];

    const body = JSON.stringify({
      model: this.model,
      messages,
      stream: false,
      // gemma4 is a *thinking* model — disable reasoning so the reply lands in
      // message.content (speakable) rather than message.thinking, and to keep
      // voice latency low. Re-enable per-call for hard reasoning tasks later.
      think: false,
      options: {
        temperature: 0.7,
        top_p: 0.9,
        num_ctx: 131072,      // Gemma 4 understøtter op til 256K — 128K giver god plads til store kodefiler
        num_predict: 4096,    // Max output tokens (øget til lange svar)
      },
      format: 'json',
    });

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(240_000), // 4 min — gemma4:31b kan tage lang tid
    });

    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as OllamaChatResponse;
    return {
      text: data.message?.content?.trim() ?? '(tomt svar)',
      tokens: data.eval_count,
    };
  }

  // ── Streaming chat (for future use in TTS pipeline) ──

  async *chatStream(
    userText: string,
    history: Array<{ role: string; content: string }> = [],
  ): AsyncGenerator<string> {
    const messages: OllamaMessage[] = [
      { role: 'system', content: currentSystemPrompt() },
      ...history.map(h => ({
        role: (h.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: h.content,
      })),
      { role: 'user', content: userText },
    ];

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, stream: true, think: false, format: 'json' }),
      signal: AbortSignal.timeout(240_000),
    });

    if (!res.ok || !res.body) throw new Error(`Ollama stream error: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const json = JSON.parse(line) as OllamaChatResponse;
          const chunk = json.message?.content ?? '';
          if (chunk) yield chunk;
          if (json.done) return;
        } catch { /* incomplete chunk */ }
      }
    }
  }

  getModel(): string { return this.model; }
  isOnline(): boolean { return this.isAvailable; }
}
