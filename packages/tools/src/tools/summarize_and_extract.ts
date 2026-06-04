import { registerTool } from '../registry.js';

registerTool({
  name: 'summarize_and_extract',
  description: 'Summarizes a text chunk and extracts key entities.',
  params: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to process.'
      }
    },
    required: ['text']
  } as any,
  async run(args: any, ctx: any) {
    const text = args.text;
    if (!text || text.length < 10) {
      return { summary: 'Text too short to summarize.', entities: [] };
    }

    const sentences = text.split(/[.!?]+/).filter((s: string) => s.trim().length > 0);
    const summary = sentences.slice(0, Math.max(1, Math.floor(sentences.length / 2))).join('. ') + '.';

    const entities: string[] = [];
    const words = text.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const word = words[i].replace(/[^a-zA-Z]/g, '');
      if (word.length > 1 && /^[A-Z]/.test(word)) {
        if (!entities.includes(word)) {
          entities.push(word);
        }
      }
    }

    return {
      summary,
      entities: entities.slice(0, 10)
    };
  }
});