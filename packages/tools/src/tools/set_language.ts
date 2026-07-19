import { registerTool } from '../registry.js';
import { settings, parseLanguage, languageName } from '@grace/core';

// Switch Grace's language mode (reply language + voice; STT forced-language follows when wired).
// Danish is Mikkel's default at home; English is for when English-speaking friends are around.
registerTool({
  name: 'set_language',
  description: 'Switch the language Grace speaks in. Call this when Mikkel asks to change language — e.g. "switch to English", "talk English now", "let\'s speak English", "skift til dansk", "på dansk igen". English mode is for English-speaking guests; Danish is the default at home. After switching, reply in the new language.',
  params: {
    language: { type: 'string', description: 'the language to switch to: "danish"/"da" or "english"/"en"', required: true },
  },
  async run(args) {
    const lang = parseLanguage(String(args.language ?? ''));
    if (!lang) return { error: `Unrecognised language "${args.language}". Use "danish" or "english".` };
    const active = settings.setLanguage(lang);
    const name = languageName(active);
    return {
      language: active,
      languageName: name,
      note: `Switched to ${name} mode. Reply to Mikkel in ${name} from here on.`,
    };
  },
});
