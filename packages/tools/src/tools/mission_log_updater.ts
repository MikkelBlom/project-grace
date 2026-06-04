import { registerTool } from '../registry.js';

registerTool({
  name: 'mission_log_updater',
  description: 'Appends progress updates and validation results to a mission log file.',
  params: {
    type: 'object',
    properties: {
      update: { type: 'string', description: 'The update message' },
      log_path: { type: 'string', description: 'The absolute path to the log file' }
    },
    required: ['update']
  } as any,
  async run(args: any, ctx: any) {
    const update = args.update;
    const logPath = args.log_path || 'C:\Users\mikke\mission_log.txt';
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${update}\n`;

    try {
      await ctx.callTool('write_file', {
        path: logPath,
        content: logEntry,
        mode: 'append'
      });
      return { success: true, message: `Logged: ${update}` };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
});