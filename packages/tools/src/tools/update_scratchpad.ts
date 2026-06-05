import { graceMemory, type ScratchpadPatch } from '@grace/core';
import { registerTool } from '../registry.js';

function listify(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(/\r?\n|\s*\|\s*|\s*;\s*/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function patchFromArgs(args: Record<string, unknown>): ScratchpadPatch {
  return {
    objective: typeof args.objective === 'string' ? args.objective : undefined,
    status: typeof args.status === 'string' ? args.status as ScratchpadPatch['status'] : undefined,
    plan: listify(args.plan),
    currentStep: typeof args.currentStep === 'string' ? args.currentStep : undefined,
    completedSteps: listify(args.completedSteps),
    artifacts: listify(args.artifacts),
    filePaths: listify(args.filePaths),
    hypotheses: listify(args.hypotheses),
    openRisks: listify(args.openRisks),
    verification: listify(args.verification),
    notes: listify(args.notes),
    summary: typeof args.summary === 'string' ? args.summary : undefined,
    reset: args.reset === true,
  };
}

registerTool({
  name: 'update_scratchpad',
  description: 'Update the persistent mission/task scratchpad. Use this to keep plans, file paths, intermediate results, hypotheses, risks, and verification state current across turns and restarts.',
  params: {
    objective: { type: 'string', description: 'optional objective for the active work item' },
    status: { type: 'string', description: 'planning, active, paused, done, failed, or cancelled' },
    plan: { type: 'string', description: 'plan items separated by newlines, semicolons, or pipes' },
    currentStep: { type: 'string', description: 'current step being worked on' },
    completedSteps: { type: 'string', description: 'completed steps separated by newlines, semicolons, or pipes' },
    artifacts: { type: 'string', description: 'artifacts or outputs separated by newlines, semicolons, or pipes' },
    filePaths: { type: 'string', description: 'file paths separated by newlines, semicolons, or pipes' },
    hypotheses: { type: 'string', description: 'open hypotheses separated by newlines, semicolons, or pipes' },
    openRisks: { type: 'string', description: 'open risks separated by newlines, semicolons, or pipes' },
    verification: { type: 'string', description: 'verification notes separated by newlines, semicolons, or pipes' },
    notes: { type: 'string', description: 'freeform scratchpad notes separated by newlines, semicolons, or pipes' },
    summary: { type: 'string', description: 'short summary of the current workspace state' },
    reset: { type: 'boolean', description: 'clear the current scratchpad before applying the patch' },
  },
  async run(args) {
    const workspace = graceMemory.updateScratchpad(patchFromArgs(args), 'update_scratchpad');
    return {
      ok: true,
      workspace,
      message: `Scratchpad updated for ${workspace.kind} ${workspace.id}`,
    };
  },
});