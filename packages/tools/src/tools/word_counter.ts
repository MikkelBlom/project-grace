import { registerTool } from '../registry.js';

registerTool({
  name: 'word_counter',
  description: 'Counts the number of words in a provided string.',
  params: {
    text: {
      type: 'string',
      description: 'The text to count words in.'
    }
  },
  async run(args: any) {
    const text = args.text || '';
    const count = text.trim().split(/\s+/).filter((w: string) => w.length > 0).length;
    return { content: `Word count: ${count}` };
  }
});