import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerTool } from '../registry.js';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const STORIES_DIR = path.join(ROOT, 'data', 'stories');

function storyFile(name: string): string {
  const safe = name.trim().toLowerCase().replace(/[^a-z0-9æøå_-]+/g, '-').replace(/^-+|-+$/g, '') || 'story';
  return path.join(STORIES_DIR, `${safe}.md`);
}

// Story / creative co-authoring mode — Grace keeps a story's plot points, characters and notes so
// she can continue it with continuity (the vision doc's "Story mode", backed by a simple file).
registerTool({
  name: 'story_add',
  description: 'Add to a creative writing / story project — a plot point, character, or note. Grace remembers it so she can co-write with continuity. Use during story or creative-writing work.',
  params: {
    story: { type: 'string', description: 'the story name/id', required: true },
    entry: { type: 'string', description: 'the plot point, character, or note to remember', required: true },
  },
  async run(args) {
    const story = String(args.story ?? '').trim();
    const entry = String(args.entry ?? '').trim();
    if (!story || !entry) return { error: 'story and entry are required' };
    const file = storyFile(story);
    try {
      fs.mkdirSync(STORIES_DIR, { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, `# ${story}\n\n`, 'utf8');
      fs.appendFileSync(file, `- ${entry}\n`, 'utf8');
    } catch (e) { return { error: String(e) }; }
    return { ok: true, story, added: entry };
  },
});

registerTool({
  name: 'story_recall',
  description: 'Recall everything saved for a story so far (plot points, characters, notes) so Grace can continue it with continuity.',
  params: { story: { type: 'string', description: 'the story name/id', required: true } },
  async run(args) {
    const story = String(args.story ?? '').trim();
    if (!story) return { error: 'story is required' };
    const file = storyFile(story);
    try {
      if (!fs.existsSync(file)) return { story, found: false, note: 'No story saved yet — use story_add.' };
      return { story, found: true, content: fs.readFileSync(file, 'utf8') };
    } catch (e) { return { story, error: String(e) }; }
  },
});
