import { registerTool } from '../registry.js';

registerTool({
  name: 'phase_3_consolidation',
  description: 'Analyzes Phase 1 and Phase 2 files in Grace\'s Mission folder to create a prioritized development plan in fase 3-plan.',
  params: {
    type: 'object',
    properties: {}
  } as any,
  async run(args, ctx) {
    if (!ctx) {
      return { error: 'Context is undefined.' };
    }
    const folderPath = "C:\\Users\\mikke\\Documents\\Grace's Mission";
    const files = [
      `${folderPath}\\fase 1 selvvurdering`,
      `${folderPath}\\fase 2 research`
    ];
    
    let combinedContent = '';

    for (const filePath of files) {
      try {
        const result = await ctx.callTool('read_file', { path: filePath });
        const content = typeof result === 'string' ? result : (result as any).content;
        combinedContent += `\n--- Content from ${filePath} ---\n${content}\n`;
      } catch (error: any) {
        combinedContent += `\nError reading ${filePath}: ${error.message}\n`;
      }
    }

    if (!combinedContent.trim()) {
      return { content: 'Could not find or read Phase 1 or Phase 2 files to consolidate.' };
    }

    const planContent = `Prioritized Development Plan\n\nBased on the analysis of Phase 1 and Phase 2:\n\n${combinedContent}\n\n(Note: This tool performs the structural consolidation. Actual intelligent prioritization requires the core LLM logic.)`;

    try {
      await ctx.callTool('write_file', {
        path: `${folderPath}\\fase 3-plan`,
        content: planContent,
        mode: 'overwrite'
      });
      return { content: 'Phase 3 plan has been created successfully.' };
    } catch (error: any) {
      return { error: `Failed to write plan: ${error.message}` };
    }
  }
});