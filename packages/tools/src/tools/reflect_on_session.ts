import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerTool } from '../registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MEMORY_PATH = path.join(ROOT, 'data', 'grace-memory.json');
const PERSONALITY_PATH = path.join(ROOT, 'config', 'personality.json');
const OLLAMA_URL = process.env.OLLAMA_API_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.GRACE_LLM_MODEL ?? 'gemma4:26b';

function redactSensitiveInfo(text: string): string {
  if (!text) return text;
  let redacted = text.replace(/\b\d{6}-\d{4}\b/g, '[REDACTED_CPR]');
  redacted = redacted.replace(/sk-[A-Za-z0-9_]{20,}/g, '[REDACTED_KEY]');
  return redacted;
}

registerTool({
  name: 'reflect_on_session',
  description: 'Analyzes recent conversation logs to extract persistent user preferences or rules, and proposes JSON updates to Grace\'s personality configuration.',
  params: {
    numTurns: { type: 'number', description: 'Number of recent turns to analyze (default: 50)' },
  },
  async run(args) {
    const numTurns = typeof args.numTurns === 'number' ? args.numTurns : 50;

    if (!fs.existsSync(MEMORY_PATH)) {
      return { ok: false, error: 'No memory logs found to analyze.' };
    }

    let memory;
    try {
      memory = JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf-8'));
    } catch (e) {
      return { ok: false, error: 'Failed to parse memory logs.' };
    }

    const turns = memory.turns || [];
    if (turns.length === 0) {
      return { ok: false, error: 'Memory logs are empty.' };
    }

    const recentTurns = turns.slice(-numTurns);
    const logText = recentTurns.map((t: any) => `${t.role.toUpperCase()}: ${t.content}`).join('\n');
    const safeLogText = redactSensitiveInfo(logText);

    let currentPersonality = '';
    try {
      const p = JSON.parse(fs.readFileSync(PERSONALITY_PATH, 'utf-8'));
      currentPersonality = `Current Traits:\n${(p.traits || []).join('\n')}\n\nCurrent Rules:\n${(p.rules || []).join('\n')}\n\nCurrent Speaking Style:\n${(p.speakingStyle || []).join('\n')}`;
    } catch (e) {
      currentPersonality = 'Could not load current personality.';
    }

    const prompt = `You are an AI assistant analyzing a conversation log to extract persistent preferences, rules, and personality traits for an AI agent named Grace.
Based on the following conversation excerpt, what new explicit rules or persistent preferences did the user ask for?

Current Personality:
${currentPersonality}

Recent Conversation:
${safeLogText}

Return a JSON object with proposed additions. Do not include things that are already in the current personality.
If there are no new preferences to add, return empty arrays.
Format strictly as JSON:
{
  "proposed_traits_additions": ["trait 1"],
  "proposed_rules_additions": ["rule 1"],
  "proposed_speakingStyle_additions": ["style 1"],
  "reasoning": "brief explanation"
}
Output ONLY valid JSON.
`;

    try {
      const payload = {
        model: MODEL,
        prompt: prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.1 }
      };

      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60000)
      });
      
      if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
      const result = await res.json();
      
      let rawText = (result as any).response || '';
      let jsonStr = rawText;
      const match = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match) jsonStr = match[1];
      const start = jsonStr.indexOf('{');
      const end = jsonStr.lastIndexOf('}');
      if (start !== -1 && end !== -1) jsonStr = jsonStr.slice(start, end + 1);

      const parsed = JSON.parse(jsonStr);
      return {
        ok: true,
        proposals: parsed,
        message: 'Reflection complete. Use update_personality tool to apply these proposed additions.'
      };

    } catch (e) {
      return { ok: false, error: `Failed to generate reflection via Ollama: ${String(e)}` };
    }
  }
});
