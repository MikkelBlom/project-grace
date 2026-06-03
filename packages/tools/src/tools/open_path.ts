import { registerTool } from '../registry.js';

// Open a file, folder, or application by absolute path.
registerTool({
  name: 'open_path',
  description: 'Open a local file, folder, or application by absolute path using default system associations (e.g. opening a file in Notepad or VS Code, or a folder in Explorer). Only allowed under the home folder or for safe system utilities.',
  params: {
    path: { type: 'string', description: 'absolute path to the file, folder, or application to open', required: true },
    app: { type: 'string', description: 'optional name of the application to open the file with (e.g., "notepad", "code")' },
  },
  async run(args) {
    const os = await import('os');
    const fs = await import('fs/promises');
    const path = await import('path');
    const { spawn } = await import('child_process');

    const raw = String(args.path ?? '');
    if (!raw) throw new Error('path is required');
    const app = args.app ? String(args.app).trim() : '';

    const isAppSafe = !app || ['notepad', 'notepad.exe', 'code', 'code.cmd', 'explorer', 'explorer.exe'].includes(app.toLowerCase());
    if (!isAppSafe) {
      return { error: `Refused: The application "${app}" is not an allowed safe system application.` };
    }

    const home = path.resolve(os.homedir());
    const platform = os.platform();

    // Check if it is a bare command name (no path separators)
    const isBareCommand = !raw.includes('/') && !raw.includes('\\');
    let p = raw;
    if (!isBareCommand) {
      p = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(home, raw);
    }

    // Gating for safety: default-deny.
    // Must be under the home folder, OR a safe system app (like notepad, explorer, etc.)
    const isUnderHome = !isBareCommand && p.startsWith(home);
    const isSafeSystemApp =
      (isBareCommand && ['notepad', 'notepad.exe', 'code', 'code.cmd', 'explorer', 'explorer.exe', 'calc', 'calc.exe'].includes(p.toLowerCase())) ||
      (!isBareCommand && platform === 'win32' && (
        p.toLowerCase().startsWith('c:\\windows\\system32\\') || 
        p.toLowerCase().startsWith('c:\\windows\\')
      ) && (
        p.toLowerCase().endsWith('notepad.exe') ||
        p.toLowerCase().endsWith('calc.exe') ||
        p.toLowerCase().endsWith('explorer.exe') ||
        p.toLowerCase().endsWith('mspaint.exe')
      ));

    if (!isUnderHome && !isSafeSystemApp) {
      return { error: `Refused: ${p} is outside your home folder (${home}) and not an allowed safe system application.` };
    }

    // Safety: never RUN programs/scripts under home (only the whitelisted system apps above
    // may be executables). Open documents, folders, and media — not arbitrary code.
    if (isUnderHome && !isBareCommand) {
      const ext = path.extname(p).toLowerCase();
      const danger = new Set(['.exe', '.bat', '.cmd', '.com', '.ps1', '.psm1', '.msi', '.scr', '.vbs', '.vbe', '.js', '.jar', '.reg', '.lnk']);
      if (danger.has(ext)) {
        return { error: `Refused: ${p} looks executable (${ext}). open_path will not run programs or scripts — open documents, folders, or media instead.` };
      }
    }

    // Check file/folder existence if it's not a bare command
    if (!isBareCommand) {
      try {
        await fs.stat(p);
      } catch (e) {
        return { path: p, error: `Path does not exist: ${p}` };
      }
    }

    try {
      // Build the platform-specific spawn arguments.
      // We spawn detached and ignore stdio to prevent Node from hanging on GUI applications.
      let child;
      if (platform === 'win32') {
        const spawnArgs = ['/c', 'start', '""'];
        if (app) spawnArgs.push(app);
        spawnArgs.push(p);
        child = spawn('cmd.exe', spawnArgs, {
          detached: true,
          stdio: 'ignore'
        });
      } else if (platform === 'darwin') {
        const spawnArgs = [];
        if (app) { spawnArgs.push('-a'); spawnArgs.push(app); }
        spawnArgs.push(p);
        child = spawn('open', spawnArgs, {
          detached: true,
          stdio: 'ignore'
        });
      } else {
        child = spawn('xdg-open', [p], {
          detached: true,
          stdio: 'ignore'
        });
      }

      child.unref();
      return { path: p, ok: true };
    } catch (e) {
      return { path: p, error: String(e) };
    }
  },
});
