import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { registerTool } from '../registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PERSONALITY_PATH = path.join(ROOT, 'config', 'personality.json');

registerTool({
  name: 'update_personality',
  description: 'Securely updates Grace\'s personality traits, rules, or speaking style. Validates schema and auto-commits the changes to Git.',
  params: {
    field: { type: 'string', description: 'The field to update: "traits", "speakingStyle", or "rules"', required: true },
    action: { type: 'string', description: 'Action to perform: "add" to append items, "replace" to replace the whole array', required: true },
    items: { type: 'array', description: 'Array of strings to add or use as replacement', required: true },
  },
  async run(args) {
    const { field, action, items } = args;
    
    if (!['traits', 'speakingStyle', 'rules'].includes(field)) {
      return { ok: false, error: 'Invalid field. Must be traits, speakingStyle, or rules.' };
    }
    if (!['add', 'replace'].includes(action)) {
      return { ok: false, error: 'Invalid action. Must be add or replace.' };
    }
    if (!Array.isArray(items) || items.some(i => typeof i !== 'string')) {
      return { ok: false, error: 'Items must be an array of strings.' };
    }

    if (!fs.existsSync(PERSONALITY_PATH)) {
      return { ok: false, error: `Personality file not found at ${PERSONALITY_PATH}` };
    }

    let data;
    try {
      const content = fs.readFileSync(PERSONALITY_PATH, 'utf-8');
      data = JSON.parse(content);
    } catch (e) {
      return { ok: false, error: `Failed to read or parse personality.json: ${String(e)}` };
    }

    // Backup in memory
    const originalField = data[field] ? [...data[field]] : [];

    if (action === 'add') {
      data[field] = [...originalField, ...items];
    } else {
      data[field] = items;
    }

    // Validate schema
    if (typeof data.name !== 'string' || typeof data.version !== 'number' || typeof data.identity !== 'string') {
      return { ok: false, error: 'Schema validation failed: missing or invalid core fields (name, version, identity).' };
    }
    if (!Array.isArray(data.traits) || !Array.isArray(data.rules) || !Array.isArray(data.speakingStyle)) {
      return { ok: false, error: 'Schema validation failed: traits, rules, and speakingStyle must be arrays.' };
    }

    // Write file
    try {
      fs.writeFileSync(PERSONALITY_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    } catch (e) {
      return { ok: false, error: `Failed to write personality.json: ${String(e)}` };
    }

    // Git commit
    let gitMessage = '';
    try {
      execSync(`git add "${PERSONALITY_PATH}"`, { cwd: ROOT });
      const commitMsg = `chore(personality): ${action} ${items.length} item(s) to ${field}`;
      execSync(`git commit -m "${commitMsg}"`, { cwd: ROOT });
      gitMessage = 'Changes committed to git.';
    } catch (e) {
      gitMessage = `Git commit failed (maybe no changes or no git repo): ${String(e)}`;
    }

    return {
      ok: true,
      message: `Successfully updated ${field}. ${gitMessage}`,
      updatedCount: data[field].length,
      newItems: action === 'add' ? items : undefined
    };
  }
});
