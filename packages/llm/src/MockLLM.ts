// ─────────────────────────────────────────────
// MockLLM — simulates Gemma 4 31B for Phase 0
// Responds contextually to common Grace queries
// Replace with OllamaLLM / vLLM client in Phase 1
// ─────────────────────────────────────────────

import { bus } from '@grace/core';

const RESPONSES: Array<[RegExp, string]> = [
  [/status|system|kørende/i,
    'Fase 0 er oppe og køre. EventBus er aktiv, overlay er online, og alle mock-services kommunikerer korrekt. Vi venter på Phase 1 — de rigtige modeller på den nye maskine.'],
  [/overlay|hud|visning/i,
    'Overlayets state-machine har fire tilstande: idle, listening (lilla puls), thinking (amber rotation) og speaking (grøn animation). I Diskret Mode vises en rød indikator.'],
  [/arkitektur|design|opbygget/i,
    'Jeg er bygget som mikroservices der taler via en TypeScript EventBus. STT → Core → LLM → TTS er den primære strøm. Electron-overlay modtager state-updates via IPC. Ingen service afhænger direkte af en anden — kun af events.'],
  [/hukommelse|memory|chromadb/i,
    'Hukommelsessystemet er to-lags: SQLite for strukturerede data og ChromaDB for semantiske vektorer. RAG-pipelinen kører automatisk — dine samtaler embeddes og hentes som kontekst inden Gemma svarer. Det implementeres i Fase 4.'],
  [/brainstorm/i,
    'Brainstorm mode aktiveret. VAD-timeout er deaktiveret — jeg lytter uden at afbryde. Fortæl løs, og sig "hvad synes du?" når du er klar til min analyse.'],
  [/diskret|privat/i,
    'Diskret Mode er aktiv når inkognito-browseren detekteres, en app på din liste er aktiv, eller du siger det direkte. Al logging og vision suspenderes øjeblikkeligt. Nul data gemmes — ikke engang denne samtale.'],
  [/sortere|typescript|funktion|kode/i,
    'Her er en generisk sort-funktion:\n\n```typescript\nconst sortBy = <T>(arr: T[], key: keyof T, dir: "asc" | "desc" = "asc"): T[] =>\n  [...arr].sort((a, b) => {\n    if (a[key] < b[key]) return dir === "asc" ? -1 : 1;\n    if (a[key] > b[key]) return dir === "asc" ? 1 : -1;\n    return 0;\n  });\n```\n\nBrug: sortBy(users, "name") eller sortBy(items, "price", "desc")'],
];

const FALLBACK_RESPONSES = [
  'Noteret. Hvad skal jeg gøre med det?',
  'Interessant. Har du overvejet at...? — mine rigtige tanker kommer i Fase 1 med Gemma 31B.',
  'Jeg er stadig i mock-mode. Den fulde version af mig har 31 milliarder parametre og et kontekstvindue på 128k tokens. Glæder mig.',
  'Det vil jeg gerne hjælpe med. Giv mig lidt mere kontekst.',
];

export class MockLLM {
  private responseIdx = 0;

  constructor() {
    this.setupListeners();
    console.log('[MockLLM] Started — kontekstuelle mock-svar aktive');
    console.log('[MockLLM] Phase 1: erstattes med Gemma 4 31B via Ollama/vLLM');
  }

  private setupListeners(): void {
    bus.on('llm:thinking', async ({ sessionId, text: userText }) => {
      // Simulate realistic LLM latency
      const latency = 800 + Math.random() * 1000;
      await new Promise(r => setTimeout(r, latency));

      const text = userText
        ? this.generateContextual(userText, sessionId)
        : this.generateResponse(sessionId);

      bus.emit('llm:response', {
        text,
        sessionId,
        model: 'mock-llm-v0',
        tokens: Math.floor(text.split(' ').length * 1.3),
      });
    });
  }

  private generateResponse(sessionId: string): string {
    // Try to find a contextual response based on the last heard text
    // In mock mode we don't have direct access to the text,
    // so we cycle through fallbacks (real LLM will have full context)
    const fallback = FALLBACK_RESPONSES[this.responseIdx % FALLBACK_RESPONSES.length]!;
    this.responseIdx++;
    return fallback;
  }

  /** Called by Core with the actual user text for context matching */
  generateContextual(text: string, sessionId: string): string {
    for (const [pattern, response] of RESPONSES) {
      if (pattern.test(text)) return response;
    }
    return FALLBACK_RESPONSES[this.responseIdx++ % FALLBACK_RESPONSES.length]!;
  }
}
