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
import { describeTools, parseToolCall, runTool } from './tools.js';

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

      // Speak complete sentences from a buffer as they form (low-latency streaming).
      const flushSentences = (buf: string): number => {
        const re = /[^.!?…]+[.!?…]+["')\]]*(?:\s|$)/g;
        let consumed = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(buf)) !== null) {
          const s = m[0].trim();
          if (s) bus.emit('tts:speaking', { text: s, sessionId });
          consumed = re.lastIndex;
        }
        return consumed;
      };
      // Consume a token stream, speaking each sentence as it completes. Returns full text.
      const speakStream = async (gen: AsyncGenerator<string>): Promise<string> => {
        let full = '', spoken = 0;
        for await (const chunk of gen) {
          full += chunk;
          spoken += flushSentences(full.slice(spoken));
        }
        const tail = full.slice(spoken).trim();
        if (tail) bus.emit('tts:speaking', { text: tail, sessionId });
        return full;
      };

      try {
        // Stream the reply, speaking sentences live — UNLESS the opening char shows it's
        // a tool call ('{'), a <SKIP> ('<'), or a code fence ('`'), which we buffer first.
        let full = '', spoken = 0;
        let mode: '' | 'speak' | 'hold' = '';
        for await (const chunk of this.chatStream(text, history ?? [])) {
          full += chunk;
          if (mode === '') {
            const t = full.trimStart();
            if (t.length >= 1) mode = (t[0] === '{' || t[0] === '<' || t[0] === '`') ? 'hold' : 'speak';
          }
          if (mode === 'speak') spoken += flushSentences(full.slice(spoken));
        }

        if (mode === 'speak') {
          const tail = full.slice(spoken).trim();
          if (tail) bus.emit('tts:speaking', { text: tail, sessionId });
          bus.emit('llm:response', { text: full, sessionId, model: this.model, spoken: true });
          return;
        }

        // 'hold' / empty — classify the buffered reply.
        const call = parseToolCall(full);
        if (call) {
          const callId = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          console.log(`[OllamaLLM] 🔧 tool: ${call.tool}`, call.args);
          bus.emit('overlay:notification', { text: `🔧 ${call.tool}`, level: 'info', duration: 2500 });
          bus.emit('tool:execute', { name: call.tool, args: call.args, callId });
          const started = Date.now();
          const result = await runTool(call.tool, call.args);
          bus.emit('tool:result', { callId, result, duration_ms: Date.now() - started });
          const answer = await speakStream(this.chatStream(
            `You called the tool "${call.tool}" and got this result (JSON): ${JSON.stringify(result)}. ` +
            `Mikkel's original message was: "${text}". Answer him briefly and naturally in English using ONLY this result. ` +
            `If the result has an error or is empty, say so honestly. Do NOT call another tool.`,
            history ?? [],
          ));
          bus.emit('llm:response', { text: answer, sessionId, model: this.model, spoken: true });
          return;
        }

        if (SKIP_RE.test(full)) {
          bus.emit('llm:response', { text: '', sessionId, model: this.model, spoken: true });
          return;
        }

        // Held on '<'/'`' but not actually a skip/tool — just speak it.
        const consumed = flushSentences(full);
        const tail = full.slice(consumed).trim();
        if (tail) bus.emit('tts:speaking', { text: tail, sessionId });
        bus.emit('llm:response', { text: full, sessionId, model: this.model, spoken: true });
      } catch (err) {
        console.error('[OllamaLLM] Chat error:', err);
        bus.emit('system:error', {
          source: 'OllamaLLM',
          error: String(err),
          recoverable: true,
        });
        // Graceful fallback (spoken via GraceCore since nothing was streamed).
        bus.emit('llm:response', {
          text: `Sorry — I couldn't reach Ollama at ${OLLAMA_URL}. Make sure it's running and ${this.model} is pulled.`,
          sessionId,
          model: this.model,
          spoken: false,
        });
      }
    });
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
