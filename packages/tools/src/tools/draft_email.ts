import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerTool } from '../registry.js';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DRAFTS_DIR = path.join(ROOT, 'data', 'drafts');

// Compose an email DRAFT to a file. Grace never SENDS email — Mikkel reviews and sends it himself.
registerTool({
  name: 'draft_email',
  description: 'Compose an email DRAFT and save it to a file for Mikkel to review and send himself. Grace never sends email. Use when he asks to draft or write an email.',
  params: {
    subject: { type: 'string', description: 'the email subject', required: true },
    body: { type: 'string', description: 'the email body', required: true },
    to: { type: 'string', description: 'recipient (for the draft header, optional)' },
  },
  async run(args) {
    const subject = String(args.subject ?? '').trim();
    const body = String(args.body ?? '').trim();
    if (!subject || !body) return { error: 'subject and body are required' };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(DRAFTS_DIR, `draft-${stamp}.txt`);
    const content = `To: ${String(args.to ?? '').trim()}\nSubject: ${subject}\n\n${body}\n`;
    try {
      fs.mkdirSync(DRAFTS_DIR, { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
    } catch (e) { return { error: String(e) }; }
    return { ok: true, savedTo: file, note: 'Draft saved — review and send it yourself. Grace does not send email.' };
  },
});
