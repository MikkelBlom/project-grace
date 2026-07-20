import { undoManager } from '@grace/core';
import { registerTool } from '../registry.js';

registerTool({
  name: 'undo_last',
  description: "Undo Grace's most recent reversible action — restore a file she wrote/edited/deleted, move a file back, or remove a folder she created. Use when Mikkel says 'undo that' / 'put it back', OR when Grace realises she just did something unintended and wants to reverse it herself.",
  params: {},
  async run() { return undoManager.undoLast(); },
});

registerTool({
  name: 'undo_history',
  description: "Show Grace's recent undoable actions (what can be reversed, and what already was).",
  params: { limit: { type: 'number', description: 'how many entries (default 10)' } },
  async run(args) {
    return { history: undoManager.history(Math.max(1, Math.min(50, Number(args.limit) || 10))) };
  },
});
