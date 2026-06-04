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
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describeTools, parseToolCall, runTool, TaskRegistry } from '@grace/tools';

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

const SYSTEM_PROMPT = [loadPersonality(), describeTools()].filter(Boolean).join('\n\n');

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

  constructor(model = MODEL, baseUrl = OLLAMA_URL) {
    this.model = model;
    this.baseUrl = baseUrl;
    this.setupListeners();
    this.checkAvailability();
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
              `When Mikkel refers to "that folder", "go deeper", or "the one you mentioned", reuse the FULL absolute path from this result as the search 'root'.`,
          }] : []),
          { role: 'user', content: text },
        ];
        const MAX_STEPS = 5;
        let finalText: string | null = null;
        let lastToolNote = '';
        let toolExecutedInLastStep = false;

        for (let step = 0; step < MAX_STEPS; step++) {
          const reply = await this.complete(work);
          const call = parseToolCall(reply);
          if (!call) {
            // Refuse a "promise to act" (or an empty reply) as the final answer —
            // push her to emit the tool call instead of narrating intent.
            const narrating = /\b(let me|i'?ll|i will|let'?s|i'?m going to|lad mig|jeg vil|jeg skal)\b[\s\S]{0,40}\b(search|find|look|check|see|fetch|tjek|kig|søg|lede|tjekke|restore|perform|fix|write|delete|open|move|update|create|rename|copy|save|add|remove|format|reformat|change|modify|place|relocate|overwrite|flet|slet|opret|skriv|flyt|gem|opdater|ret|ændr|tilføj|omdøb|rediger|go|start|clean|strip|do|make|run|execute|process|handle|take care|køre|starte|gøre|fikse|klare|ordne)\b/i.test(reply);
            // Also catch past-tense false claims: the LLM says "I've moved/updated/written"
            // without actually calling a tool — words alone don't change files.
            const falseClaim = !toolExecutedInLastStep && /\b(i'?ve|i have|i('?m| am)|jeg har|jeg)\b[\s\S]{0,60}\b(moved?|moving|updated?|updating|written|writing|wrote|created?|creating|deleted?|deleting|renamed?|renaming|copied|copying|saved?|saving|added|adding|removed|removing|fixed|fixing|rewritten|re-?written|rewriting|re-?writing|formatted|re-?formatted|formatting|re-?formatting|changed|changing|modified|modifying|placed|placing|relocated|relocating|overwritten|overwriting|opened|opening|flettet|slettet|oprettet|skrevet|flyttet|gemt|opdateret|rettet|ændret|tilføjet|omdøbt|redigeret)\b/i.test(reply);
            
            toolExecutedInLastStep = false;

            if (reply.trim() && !narrating && !falseClaim) { finalText = reply; break; }
            work.push({ role: 'user', content: narrating
              ? 'Do NOT narrate what you are about to do. Output the tool call JSON RIGHT NOW to actually do it.'
              : falseClaim
              ? 'You CLAIMED you already did something (moved/wrote/updated a file) but you did NOT call any tool — I see no tool JSON in your reply. Words alone do not change files. Output the tool-call JSON right now to ACTUALLY do it.'
              : 'You replied with nothing. Either output a tool call (one line of JSON), or give Mikkel a plain-English answer now.' });
            continue;
          }

          // Autonomous background task: acknowledge now, then work on it on our own.
          if (call.tool === 'start_background_task') {
            const desc = String((call.args && (call.args as Record<string, unknown>).description) || text);
            void this.runBackgroundTask(desc);
            finalText = "On it — I'll dig into that on my own and let you know when I'm done.";
            break;
          }

          const callId = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          console.log(`[OllamaLLM] 🔧 step ${step + 1}: ${call.tool}`, call.args);
          bus.emit('overlay:notification', { text: `🔧 ${call.tool}`, level: 'info', duration: 2000 });
          bus.emit('tool:execute', { name: call.tool, args: call.args, callId });
          const started = Date.now();
          const result = await runTool(call.tool, call.args);
          bus.emit('tool:result', { callId, result, duration_ms: Date.now() - started });
          console.log(`[OllamaLLM]    ↳ ${Date.now() - started}ms · ${JSON.stringify(result).slice(0, 160)}`);

          toolExecutedInLastStep = true;

          const resultJson = JSON.stringify(result);
          lastToolNote = `${call.tool}(${JSON.stringify(call.args)}) → ${resultJson.slice(0, 700)}`;
          work.push({ role: 'assistant', content: reply });
          work.push({ role: 'user', content:
            `TOOL RESULT (${call.tool}): ${resultJson}\n` +
            `If this is empty or an error, you MUST try again with a corrected query or a different tool (output a NEW tool JSON) — ` +
            `do not give up after one attempt. Danish folder names are English on disk: overførsler→Downloads, ` +
            `dokumenter→Documents, billeder→Pictures, skrivebord→Desktop. To go DEEPER into a folder, reuse the full ` +
            `absolute 'path' from a match above as the 'root'. Only once you actually have the info, answer Mikkel in plain English with NO JSON.` });
        }
        if (lastToolNote) this.lastToolContext = lastToolNote;

        if (finalText === null || !finalText.trim()) {
          finalText = await this.complete([...work, {
            role: 'user',
            content: 'Give Mikkel your best plain-English answer now based on what you found. No tools, no JSON. If you genuinely could not find it, say so briefly.',
          }]);
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
  private async complete(messages: Array<{ role: string; content: string }>, systemPrompt: string = SYSTEM_PROMPT): Promise<string> {
    const norm = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
      content: m.content,
    }));
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: systemPrompt }, ...norm],
        stream: false,
        think: false,
        options: { temperature: 0.5, top_p: 0.9, num_ctx: 32768, num_predict: 1024 },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json() as { message?: { content?: string } };
    return data.message?.content?.trim() ?? '';
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
    // Task-mode system prompt: no <SKIP>, no chit-chat — execute and verify.
    const taskSys = `${SYSTEM_PROMPT}\n\nTASK MODE: You are autonomously executing a task for Mikkel. ` +
      `Work step by step with tools. NEVER reply <SKIP>. Do not chit-chat or ask questions. Either output ONE ` +
      `tool-call JSON, or — only when the task is fully done and verified — a concise final summary with NO JSON.`;
    try {
      TaskRegistry.update('planning');
      const plan = await this.complete([{ role: 'user',
        content: `Make a short numbered plan (max 5 steps) to accomplish this with your tools. Plan only — no tool calls yet.\nTASK: ${description}` }], taskSys);
      console.log(`[Task] 📋 plan:\n${plan}`);
      TaskRegistry.log('made a plan');

      const work: Array<{ role: string; content: string }> = [{ role: 'user',
        content: `Now execute this task step by step. After you think it's done, VERIFY the result actually satisfies it — if it looks wrong or incomplete, keep digging elsewhere. Final concise summary with NO JSON when truly done.\nTASK: ${description}\nYOUR PLAN:\n${plan}` }];

      let result = '';
      const MAX = 14;
      let toolExecutedInLastStep = false;
      for (let step = 0; step < MAX; step++) {
        TaskRegistry.update(`step ${step + 1} of up to ${MAX}`);
        const reply = await this.complete(work, taskSys);
        const call = parseToolCall(reply);
        if (!call) {
          // Reject <SKIP>/empty as a result — keep executing.
          // Also reject false claims of completed actions (same guard as the main loop).
          const taskFalseClaim = !toolExecutedInLastStep && /\b(i'?ve|i have|i('?m| am)|jeg har|jeg)\b[\s\S]{0,60}\b(moved?|moving|updated?|updating|written|writing|wrote|created?|creating|deleted?|deleting|renamed?|renaming|copied|copying|saved?|saving|added|adding|removed|removing|fixed|fixing|rewritten|re-?written|rewriting|re-?writing|formatted|re-?formatted|formatting|re-?formatting|changed|changing|modified|modifying|placed|placing|relocated|relocating|overwritten|overwriting|opened|opening|flettet|slettet|oprettet|skrevet|flyttet|gemt|opdateret|rettet|ændret|tilføjet|omdøbt|redigeret)\b/i.test(reply);
          
          toolExecutedInLastStep = false;

          if (reply.trim() && !SKIP_RE.test(reply) && !taskFalseClaim) { result = reply; break; }
          work.push({ role: 'user', content: taskFalseClaim
            ? 'You CLAIMED you did something but called no tool. Output the tool-call JSON to ACTUALLY do it.'
            : 'Do not stop or reply <SKIP>. Call the next tool, or give the final verified summary now.' });
          continue;
        }
        if (call.tool === 'start_background_task') { // already in a task — don't recurse
          work.push({ role: 'user', content: 'You are already working on the task. Use real tools or finish.' });
          continue;
        }
        const tStep = Date.now();
        const res = await runTool(call.tool, call.args);
        console.log(`[Task]    step ${step + 1}: ${call.tool}(${JSON.stringify(call.args).slice(0, 80)}) ${Date.now() - tStep}ms → ${JSON.stringify(res).slice(0, 120)}`);
        TaskRegistry.log(`${call.tool} → ${JSON.stringify(res).slice(0, 90)}`);
        
        toolExecutedInLastStep = true;
        work.push({ role: 'assistant', content: reply });
        work.push({ role: 'user', content:
          `TOOL RESULT (${call.tool}): ${JSON.stringify(res).slice(0, 1800)}\n` +
          `Keep going until the task is fully done AND verified, then give a concise final summary with NO JSON.` });
      }
      if (!result.trim()) {
        result = await this.complete([...work, { role: 'user', content: 'Summarise for Mikkel what you found or did, in plain English. No tools, no JSON.' }], taskSys);
      }
      console.log(`[Task] ✓ done in ${Math.round((Date.now() - t0) / 1000)}s`);
      TaskRegistry.finish(result || 'Done.');
      bus.emit('overlay:notification', { text: '✅ Task done', level: 'info', duration: 5000 });
      announce(`Okay, I'm done. ${result || ''}`.trim());
    } catch (err) {
      TaskRegistry.fail(String(err));
      announce(`I hit a problem with that task: ${err}`);
    }
  }

  // ── Core chat method ─────────────────────────

  async chat(
    userText: string,
    history: Array<{ role: string; content: string }> = [],
  ): Promise<{ text: string; tokens?: number }> {
    const messages: OllamaMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
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
        num_ctx: 32768,       // Gemma 4 understøtter op til 128K — 32K er godt til daglig brug
        num_predict: 2048,    // Max output tokens
      },
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
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map(h => ({
        role: (h.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: h.content,
      })),
      { role: 'user', content: userText },
    ];

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, stream: true, think: false }),
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
