import { registerTool } from '../registry.js';

// Replace string content inside a text file
registerTool({
  name: 'replace_file_content',
  description: 'Replace occurrences of a specific string with a new string in a local text file. Only allowed under the user home folder. Useful for making small edits without overwriting the entire file.',
  params: {
    path: { type: 'string', description: 'absolute path of the file to edit (must be under the home folder)', required: true },
    target_string: { type: 'string', description: 'the exact string to search for and replace', required: true },
    replacement_string: { type: 'string', description: 'the new string to replace the target with', required: true },
    replace_all: { type: 'boolean', description: 'if true, replaces all occurrences. if false, only the first occurrence. default is true.' },
  },
  async run(args) {
    const os = await import('os');
    const fs = await import('fs/promises');
    const path = await import('path');
    const home = path.resolve(os.homedir());
    const raw = String(args.path ?? '');
    
    const p = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(home, raw);
    if (!p.startsWith(home)) return { error: `Refused: ${p} is outside your home folder (${home}). Only files under home can be edited.` };
    
    const target = String(args.target_string ?? '');
    const replacement = String(args.replacement_string ?? '');
    const replaceAll = args.replace_all !== false; // default true
    
    if (!target) return { error: 'target_string is required and cannot be empty.' };

    try {
      const content = await fs.readFile(p, 'utf-8');
      
      if (!content.includes(target)) {
        return { error: `The target_string was not found in the file: ${target.substring(0, 50)}...` };
      }

      let newContent = content;
      let occurrencesReplaced = 0;

      if (replaceAll) {
        // use split/join for replace all without needing to escape regex
        const parts = newContent.split(target);
        occurrencesReplaced = parts.length - 1;
        newContent = parts.join(replacement);
      } else {
        newContent = newContent.replace(target, replacement);
        occurrencesReplaced = 1;
      }

      await fs.writeFile(p, newContent, 'utf-8');
      
      return { 
        path: p, 
        occurrences_replaced: occurrencesReplaced,
        ok: true 
      };
    } catch (e) { 
      return { path: p, error: String(e) }; 
    }
  },
});
