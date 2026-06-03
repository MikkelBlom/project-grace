import { registerTool } from '../registry.js';

// Read the text content of the system clipboard.
registerTool({
  name: 'clipboard_read',
  description: 'Read the current text content of the system clipboard.',
  params: {},
  async run() {
    const { spawn } = await import('child_process');
    return new Promise((resolve) => {
      const ps = spawn('powershell.exe', [
        '-NoProfile',
        '-Command',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard'
      ]);
      let stdout = '';
      let stderr = '';
      ps.stdout.on('data', (data) => { stdout += data.toString(); });
      ps.stderr.on('data', (data) => { stderr += data.toString(); });
      ps.on('close', (code) => {
        if (code !== 0) {
          resolve({ error: `PowerShell exited with code ${code}: ${stderr.trim()}` });
        } else {
          resolve({ text: stdout.replace(/\r\n/g, '\n') });
        }
      });
      ps.on('error', (err) => {
        resolve({ error: String(err) });
      });
    });
  },
});

// Write text to the system clipboard.
registerTool({
  name: 'clipboard_write',
  description: 'Write text to the system clipboard.',
  params: {
    text: { type: 'string', description: 'the text to write to the clipboard', required: true },
  },
  async run(args) {
    const { spawn } = await import('child_process');
    const text = args.text == null ? '' : String(args.text);
    return new Promise((resolve) => {
      let command = '';
      if (!text) {
        command = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()';
      } else {
        command = '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $content = [Console]::In.ReadToEnd(); Set-Clipboard -Value $content';
      }
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command', command]);
      if (text) {
        ps.stdin.write(text, 'utf-8');
        ps.stdin.end();
      }
      let stderr = '';
      ps.stderr.on('data', (data) => { stderr += data.toString(); });
      ps.on('close', (code) => {
        if (code !== 0) {
          resolve({ error: `PowerShell exited with code ${code}: ${stderr.trim()}` });
        } else {
          resolve({ ok: true });
        }
      });
      ps.on('error', (err) => {
        resolve({ error: String(err) });
      });
    });
  },
});
