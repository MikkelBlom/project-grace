import { registerTool } from '../registry.js';

// Open a website/URL in the user's own default web browser.
registerTool({
  name: 'open_browser',
  description: "Open a website/URL in the user's default browser so they can view/browse it themselves. Returns { opened: true, url } or { error }.",
  params: {
    url: { type: 'string', description: 'The absolute http(s) URL to open in the browser', required: true },
  },
  async run(args) {
    const rawUrl = String(args.url ?? '').trim();
    if (!rawUrl) {
      return { error: 'URL is required' };
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return { error: 'Invalid URL protocol. Only http and https are allowed.' };
      }
    } catch {
      return { error: `Invalid URL format: "${rawUrl}"` };
    }

    const cleanUrl = parsedUrl.href;
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      const platform = process.platform;
      let cmd = '';
      if (platform === 'win32') {
        cmd = `cmd.exe /c start "" "${cleanUrl}"`;
      } else if (platform === 'darwin') {
        cmd = `open "${cleanUrl}"`;
      } else {
        cmd = `xdg-open "${cleanUrl}"`;
      }

      await execAsync(cmd, { timeout: 5000 });
      return { opened: true, url: cleanUrl };
    } catch (e) {
      return { error: `Failed to open browser: ${String(e)}` };
    }
  },
});
