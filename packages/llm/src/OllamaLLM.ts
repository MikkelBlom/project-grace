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
        let allSpoken: string[] = [];
        let lastToolNote = '';

        for (let step = 0; step < MAX_STEPS; step++) {
          const reply = await this.complete(work);
          console.log(`[OllamaLLM] 🧠 Raw reply:\n${reply}`);
          const call = parseToolCall(reply);
          
          if (!call) {
            work.push({ role: 'assistant', content: reply });
            work.push({ role: 'user', content: 'You MUST output valid JSON matching the required {"thought": "...", "tool": "...", "args": {...}, "speak": "...", "done": false} schema. Do not output plain text.' });
            continue;
          }

          if (call.speak && call.speak.trim()) {
            allSpoken.push(call.speak.trim());
          }

          if (!call.tool || call.tool === 'null' || call.tool === 'reply') {
            // She doesn't want to call a tool, she just wants to speak. Turn is done.
            break;
          }

          if (call.tool === 'start_background_task') {
            const desc = String((call.args && (call.args as Record<string, unknown>).description) || text);
            void this.runBackgroundTask(desc);
            if (!call.speak) allSpoken.push("On it — I'll dig into that on my own and let you know when I'm done.");
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

          const resultJson = JSON.stringify(result);
          lastToolNote = `${call.tool}(${JSON.stringify(call.args)}) → ${resultJson.slice(0, 700)}`;
          work.push({ role: 'assistant', content: reply });
          work.push({ role: 'user', content:
            `TOOL RESULT (${call.tool}): ${resultJson}\n` +
            `If this is empty or an error, you MUST try again with a corrected query or a different tool (output a NEW tool JSON) — ` +
            `do not give up after one attempt. Danish folder names are English on disk: overførsler→Downloads, ` +
            `dokumenter→Documents, billeder→Pictures, skrivebord→Desktop. To go DEEPER into a folder, reuse the full ` +
            `absolute 'path' from a match above as the 'root'. When you have the info, finish by outputting a JSON with {"thought": "...", "tool": null, "speak": "your answer"}.` });
        }
        if (lastToolNote) this.lastToolContext = lastToolNote;

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
        format: 'json',
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
    // Task-mode system prompt: no chit-chat — execute and verify.
    const taskSys = `${SYSTEM_PROMPT}\n\nTASK MODE: You are autonomously executing a task for Mikkel. ` +
      `Work step by step with tools. Do not chit-chat or ask questions. ALWAYS output ` +
      `the JSON schema. When the task is fully done and verified, output JSON with "done": true and your final concise summary in "speak".`;
    try {
      TaskRegistry.update('planning');
      const plan = await this.complete([{ role: 'user',
        content: `Make a short numbered plan (max 5 steps) to accomplish this with your tools. Output JSON with "speak": "the plan" and "tool": null.\nTASK: ${description}` }], taskSys);
      
      const parsedPlan = parseToolCall(plan)?.speak || plan;
      console.log(`[Task] 📋 plan:\n${parsedPlan}`);
      TaskRegistry.log('made a plan');

      const work: Array<{ role: string; content: string }> = [{ role: 'user',
        content: `Now execute this task step by step. After you think it's done, VERIFY the result actually satisfies it — if it looks wrong or incomplete, keep digging elsewhere. When the task is truly done, output JSON with "done": true and your summary in "speak".\nTASK: ${description}\nYOUR PLAN:\n${parsedPlan}` }];

      let result = '';
      const MAX = 14;
      for (let step = 0; step < MAX; step++) {
        TaskRegistry.update(`step ${step + 1} of up to ${MAX}`);
        const reply = await this.complete(work, taskSys);
        console.log(`[Task] 🧠 Raw reply:\n${reply}`);
        const call = parseToolCall(reply);
        
        if (!call) {
          console.warn(`[Task] ⚠️ Invalid JSON reply from model: ${reply}`);
          work.push({ role: 'assistant', content: reply });
          work.push({ role: 'user', content: 'You MUST output valid JSON matching the {"thought": "...", "tool": "...", "args": {...}, "speak": "...", "done": false} schema.' });
          continue;
        }

        if (call.done) {
           // Task done. The result is in call.speak.
           result = call.speak || 'Task finished without description.';
           break;
        }

        if (!call.tool || call.tool === 'null' || call.tool === 'reply') {
           // She just spoke without a tool and without setting done:true.
           // That's fine, it's just "thinking out loud".
           work.push({ role: 'assistant', content: reply });
           work.push({ role: 'user', content: 'What is your next step? Call a tool or set "done": true if finished.' });
           continue;
        }

        if (call.tool === 'start_background_task') { // already in a task — don't recurse
          work.push({ role: 'user', content: 'You are already working on the task. Use real tools or finish by setting "tool": null.' });
          continue;
        }
        const tStep = Date.now();
        const res = await runTool(call.tool, call.args);
        console.log(`[Task]    step ${step + 1}: ${call.tool}(${JSON.stringify(call.args).slice(0, 80)}) ${Date.now() - tStep}ms → ${JSON.stringify(res).slice(0, 120)}`);
        TaskRegistry.log(`${call.tool} → ${JSON.stringify(res).slice(0, 90)}`);
        
        work.push({ role: 'assistant', content: reply });
        work.push({ role: 'user', content:
          `TOOL RESULT (${call.tool}): ${JSON.stringify(res).slice(0, 1800)}\n` +
          `Keep going until the task is fully done AND verified, then finish by setting "done": true and putting your summary in "speak".` });
      }
      if (!result.trim()) {
        const fb = await this.complete([...work, { role: 'user', content: 'Summarise for Mikkel what you found or did. Output JSON with {"thought": "...", "tool": null, "speak": "...", "done": true}.' }], taskSys);
        result = parseToolCall(fb)?.speak || fb;
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
