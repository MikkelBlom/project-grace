import { graceMemory } from '@grace/core';
import { registerTool } from '../registry.js';

registerTool({
  name: 'get_scratchpad',
  description: 'Return the current active scratchpad workspace state (task or mission).',
  params: {},
  async run() {
    const ws = graceMemory.getActiveWorkspace();
    if (!ws) return { ok: false, error: 'no active workspace' };
    return { ok: true, workspace: ws };
  },
});
