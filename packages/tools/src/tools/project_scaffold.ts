import os from 'os';
import fs from 'fs';
import path from 'path';
import { registerTool } from '../registry.js';

// Writes are gated under the home directory — refuse anything outside it.
function isUnderHome(p: string): boolean {
  const home = path.resolve(os.homedir());
  const rel = path.relative(home, path.resolve(p));
  return rel === '' ? false : !rel.startsWith('..') && !path.isAbsolute(rel);
}

type Kind = 'node' | 'python' | 'web';

function starterFiles(kind: Kind, name: string): Record<string, string> {
  if (kind === 'node') {
    return {
      'package.json': JSON.stringify({
        name, version: '0.1.0', type: 'module', main: 'index.js',
        scripts: { start: 'node index.js' },
      }, null, 2) + '\n',
      'index.js': `console.log('Hello from ${name}');\n`,
      'README.md': `# ${name}\n\nA starter Node project.\n\n## Run\n\n\`\`\`\nnode index.js\n\`\`\`\n`,
      '.gitignore': 'node_modules/\n.env\n',
    };
  }
  if (kind === 'python') {
    return {
      'main.py': `def main() -> None:\n    print("Hello from ${name}")\n\n\nif __name__ == "__main__":\n    main()\n`,
      'requirements.txt': '',
      'README.md': `# ${name}\n\nA starter Python project.\n\n## Run\n\n\`\`\`\npy -3.12 main.py\n\`\`\`\n`,
      '.gitignore': '__pycache__/\n*.pyc\n.venv/\n.env\n',
    };
  }
  // web
  return {
    'index.html': `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>${name}</title>\n  <link rel="stylesheet" href="styles.css" />\n</head>\n<body>\n  <h1>${name}</h1>\n  <p>A starter web page.</p>\n</body>\n</html>\n`,
    'styles.css': `body { font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.5; }\n`,
    'README.md': `# ${name}\n\nA starter static web project. Open \`index.html\` in a browser.\n`,
  };
}

// Scaffold a fresh starter project folder under the home directory.
registerTool({
  name: 'project_scaffold',
  description: "Create a starter project folder with a few minimal files for a given kind ('node', 'python', or 'web'). Only creates folders under the home directory. Use when Mikkel wants to start a new project.",
  params: {
    name: { type: 'string', description: 'the project folder name', required: true },
    kind: { type: 'string', description: "project type: 'node', 'python', or 'web'", required: true },
    parent: { type: 'string', description: 'parent folder to create it in (default: home directory)' },
  },
  async run(args) {
    const name = String(args.name ?? '').trim();
    const kind = String(args.kind ?? '').trim().toLowerCase() as Kind;
    if (!name) return { error: 'name is required' };
    if (!['node', 'python', 'web'].includes(kind)) return { error: "kind must be 'node', 'python', or 'web'" };
    if (/[\\/:*?"<>|]/.test(name)) return { error: 'name contains invalid path characters' };

    const parent = args.parent ? path.resolve(String(args.parent)) : os.homedir();
    const target = path.resolve(parent, name);

    if (!isUnderHome(target)) return { error: `refusing to write outside the home directory: ${target}` };
    if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
      return { error: `target already exists and is not empty: ${target}` };
    }

    const files = starterFiles(kind, name);
    const created: string[] = [];
    try {
      fs.mkdirSync(target, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        const fp = path.join(target, rel);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, content, 'utf-8');
        created.push(rel);
      }
    } catch (e) { return { error: String(e).slice(0, 200) }; }

    return { ok: true, kind, path: target, filesCreated: created };
  },
});
