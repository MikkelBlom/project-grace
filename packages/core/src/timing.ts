// Lightweight, consistent per-turn timing. Every subsystem logs with the same `[timing]` prefix
// so a full turn's breakdown (stt → embed → llm steps → tts) can be grepped from the logs and,
// later, scraped for the eval harness. Measure latency instead of inferring it from notes.

export function logTiming(label: string, ms: number, extra?: Record<string, unknown>): void {
  const parts = Object.entries(extra ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(',')}]` : v}`)
    .join(' ');
  console.log(`[timing] ${label}=${Math.round(ms)}ms${parts ? ' ' + parts : ''}`);
}
