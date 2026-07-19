import { graceMemory } from '@grace/core';
import { registerTool } from '../registry.js';

// Show Mikkel what Grace remembers — recent turns, profile facts, and memory backend state.
registerTool({
  name: 'browse_memory',
  description: "Show what Grace currently remembers — recent conversation turns, stored profile facts about Mikkel, and the memory backend state. Use when he asks what you remember or to review your memory.",
  params: { turns: { type: 'number', description: 'how many recent turns to show (default 15)' } },
  async run(args) {
    const n = Math.max(1, Math.min(100, Number(args.turns) || 15));
    const turns = graceMemory.recentTurns(n).map((t: any) => ({
      role: t.role,
      content: String(t.content).slice(0, 160),
      when: new Date(t.ts).toISOString().slice(0, 16).replace('T', ' '),
    }));
    const state = graceMemory.getStateSummary();
    let profileFacts: string[] = [];
    try {
      const p: any = (graceMemory as any).getUserProfile?.();
      profileFacts = Array.isArray(p?.facts) ? p.facts.slice(0, 20).map((f: any) => (typeof f === 'string' ? f : f?.fact ?? JSON.stringify(f))) : [];
    } catch { /* ignore */ }
    return {
      recentTurns: turns.length,
      turns,
      profileFacts,
      semanticRecords: state.semanticRecords,
      engine: state.engine,
      semanticEngine: state.semanticEngine,
    };
  },
});
