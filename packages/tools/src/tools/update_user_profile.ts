import { graceMemory } from '@grace/core';
import { registerTool } from '../registry.js';

function listify(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(/\r?\n|\s*\|\s*|\s*;\s*/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

registerTool({
  name: 'update_user_profile',
  description: 'Persist durable facts about Mikkel, such as workflow preferences, style preferences, routine details, or recurring context. Latest valid information should win when facts conflict.',
  params: {
    facts: { type: 'string', description: 'facts separated by newlines, semicolons, or pipes' },
    category: { type: 'string', description: 'optional category to apply to the provided fact list' },
    source: { type: 'string', description: 'optional source label for the facts' },
    confidence: { type: 'number', description: '0-1 confidence for the facts' },
    notes: { type: 'string', description: 'optional profile notes separated by newlines, semicolons, or pipes' },
  },
  async run(args) {
    const category = typeof args.category === 'string' && args.category.trim() ? args.category.trim() : 'general';
    const source = typeof args.source === 'string' && args.source.trim() ? args.source.trim() : 'manual';
    const confidence = typeof args.confidence === 'number' ? Math.max(0, Math.min(1, args.confidence)) : 0.7;
    const facts = listify(args.facts).map((text) => ({ category, text, source, confidence }));
    const notes = listify(args.notes);
    const profile = graceMemory.updateUserProfile({ facts, notes });
    return {
      ok: true,
      factsAdded: facts.length,
      notesAdded: notes.length,
      profile,
      message: `User profile updated with ${facts.length} fact(s) and ${notes.length} note(s).`,
    };
  },
});