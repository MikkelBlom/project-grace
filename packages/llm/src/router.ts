// Deterministic, zero-cost router: bias the model toward the fast path (answer/act) for on-machine
// actions and chit-chat, and toward research for real-world factual questions. Just a hint — the
// model still decides — but it keeps everyday/action turns snappy and pushes facts to sources.
export function routerHint(text: string): string | null {
  const t = String(text ?? '').toLowerCase().trim();
  if (t.length < 4) return null;
  const actionRe = /\b(open|read|write|edit|delete|move|create|rename|find|search|list|show|screenshot|index|reindex|luk|åbn|læs|skriv|slet|flyt|opret|omdøb|vis|søg)\b|\bmy (file|folder|screen|desktop|project|document|note)/i;
  const localRefRe = /\b(this file|that folder|the screen|open (app|window)|min fil|min mappe|skærmen|mit projekt|den mappe)\b/i;
  const knowledgeRe = /\b(who|what|when|where|why|how (much|many|old)|latest|news|price|weather|current|today|score|released?|version|population|capital|hvem|hvad|hvornår|hvorfor|hvor (meget|mange|gammel)|nyeste|nyheder|pris|vejret|aktuel|befolkning)\b/i;
  if (actionRe.test(t) || localRefRe.test(t)) {
    return 'ROUTER: this looks like an action or something on Mikkel\'s own machine — fast path. Answer or act directly with your tools; do NOT web-search unless he explicitly asks for outside info.';
  }
  if (knowledgeRe.test(t)) {
    return 'ROUTER: this looks like a real-world factual question — unless the answer is already in the conversation above, strongly consider calling research first and answering from the sources it returns.';
  }
  return null;
}
