// ─────────────────────────────────────────────────────────────────────────────
// Gmail tools — READ-ONLY + DRAFT. Grace NEVER sends email.
//   gmail_inbox  — list recent inbox / matching messages (From, Subject, snippet)
//   gmail_read   — read one message's decoded plain-text body (capped)
//   gmail_draft  — create a DRAFT for Mikkel to review + send himself
//
// These deliberately never touch users/me/messages/send. gmail.modify scope lets
// Grace read mail and create drafts, but the send endpoint is simply never called.
// Auth via lib/google.ts; unauthenticated calls return { error, setup }.
// ─────────────────────────────────────────────────────────────────────────────

import { registerTool } from '../registry.js';
import { googleFetch, googleErrorResult } from '../lib/google.js';
import { stripHeaderCtl, isSingleRecipient } from '../lib/emailHeader.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY_CHARS = 4000;

interface GmailHeader { name?: string; value?: string; }
interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}
interface GmailMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  payload?: GmailPart;
}

const headerVal = (headers: GmailHeader[] | undefined, name: string): string =>
  headers?.find((h) => (h.name ?? '').toLowerCase() === name.toLowerCase())?.value?.trim() ?? '';

/** Decode Gmail's base64url payload data to a UTF-8 string. */
function decodeB64Url(data: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/** Base64url-encode a UTF-8 string (no padding) for a raw RFC822 message. */
function encodeB64Url(str: string): string {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 2047-encode a header value only if it contains non-ASCII (keeps Danish subjects intact). */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Walk a MIME tree and return the best readable text (prefers text/plain, falls back to text/html→stripped). */
function extractText(payload: GmailPart | undefined): string {
  if (!payload) return '';
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (part: GmailPart): void => {
    const mime = (part.mimeType ?? '').toLowerCase();
    if (part.parts?.length) {
      for (const p of part.parts) walk(p);
      return;
    }
    if (!part.body?.data) return;
    if (mime === 'text/plain') plain.push(decodeB64Url(part.body.data));
    else if (mime === 'text/html') html.push(decodeB64Url(part.body.data));
  };
  walk(payload);

  if (plain.join('').trim()) return plain.join('\n').trim();
  if (html.join('').trim()) {
    return html
      .join('\n')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return '';
}

// ── gmail_inbox ──────────────────────────────────────────────────────────────
registerTool({
  name: 'gmail_inbox',
  description:
    "List recent messages from Mikkel's Gmail (From, Subject, snippet). Default shows the inbox; pass a Gmail search query (e.g. 'is:unread', 'from:bank', 'newer_than:2d') to filter. Read-only. Use when he asks what's in his inbox / any new / unread email.",
  params: {
    query: { type: 'string', description: "Gmail search query (default 'in:inbox'). e.g. 'is:unread', 'from:someone@x.com'" },
    max: { type: 'number', description: 'how many messages to list (default 10, max 25)' },
  },
  async run(args) {
    const q = String(args.query ?? '').trim() || 'in:inbox';
    const max = Math.max(1, Math.min(25, Math.round(Number(args.max) || 10)));

    try {
      const listRes = await googleFetch(
        `${BASE}/messages?q=${encodeURIComponent(q)}&maxResults=${max}`,
      );
      if (!listRes.ok) {
        const body = (await listRes.text().catch(() => '')).slice(0, 200);
        return { error: `Gmail API HTTP ${listRes.status}. ${body}` };
      }
      const list = (await listRes.json()) as { messages?: Array<{ id: string }> };
      const ids = (list.messages ?? []).map((m) => m.id);
      if (!ids.length) return { query: q, count: 0, messages: [], note: 'No matching messages.' };

      const metaUrl = (id: string) =>
        `${BASE}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;

      const messages = await Promise.all(
        ids.map(async (id) => {
          try {
            const r = await googleFetch(metaUrl(id));
            if (!r.ok) return { id, error: `HTTP ${r.status}` };
            const m = (await r.json()) as GmailMessage;
            const h = m.payload?.headers;
            return {
              id,
              from: headerVal(h, 'From'),
              subject: headerVal(h, 'Subject') || '(no subject)',
              date: headerVal(h, 'Date'),
              snippet: (m.snippet ?? '').trim(),
            };
          } catch (e) {
            return { id, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );

      return { query: q, count: messages.length, messages };
    } catch (e) {
      return googleErrorResult(e);
    }
  },
});

// ── gmail_read ───────────────────────────────────────────────────────────────
registerTool({
  name: 'gmail_read',
  description:
    'Read one Gmail message in full by its id (get the id from gmail_inbox first). Returns sender, subject, date and the decoded plain-text body (capped). Read-only.',
  params: {
    id: { type: 'string', description: 'the message id from gmail_inbox', required: true },
  },
  async run(args) {
    const id = String(args.id ?? '').trim();
    if (!id) return { error: 'id is required (get it from gmail_inbox)' };

    try {
      const res = await googleFetch(`${BASE}/messages/${encodeURIComponent(id)}?format=full`);
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 200);
        return { error: `Gmail API HTTP ${res.status}. ${body}` };
      }
      const m = (await res.json()) as GmailMessage;
      const h = m.payload?.headers;
      let body = extractText(m.payload);
      const truncated = body.length > MAX_BODY_CHARS;
      if (truncated) body = body.slice(0, MAX_BODY_CHARS);

      return {
        id: m.id ?? id,
        from: headerVal(h, 'From'),
        to: headerVal(h, 'To'),
        subject: headerVal(h, 'Subject') || '(no subject)',
        date: headerVal(h, 'Date'),
        body: body || (m.snippet ?? '').trim() || '(no readable text body)',
        truncated: truncated || undefined,
      };
    } catch (e) {
      return googleErrorResult(e);
    }
  },
});

// ── gmail_draft ──────────────────────────────────────────────────────────────
registerTool({
  name: 'gmail_draft',
  description:
    'Create a Gmail DRAFT (to, subject, body) that Mikkel can review and send himself. Grace NEVER sends email — this only saves a draft. Use when he asks to draft/write/reply to an email that should live in Gmail.',
  params: {
    to: { type: 'string', description: 'recipient email address', required: true },
    subject: { type: 'string', description: 'email subject', required: true },
    body: { type: 'string', description: 'plain-text body of the email', required: true },
  },
  async run(args) {
    // Header-injection guard: strip CR/LF/other control chars so a crafted `to`/`subject` (e.g. from
    // an injected email Grace is replying to) can't smuggle extra headers like a hidden Bcc: into the draft.
    const to = stripHeaderCtl(String(args.to ?? ''));
    const subject = stripHeaderCtl(String(args.subject ?? ''));
    const body = String(args.body ?? '');
    if (!to || !subject || !body.trim()) return { error: 'to, subject and body are all required' };
    if (!isSingleRecipient(to)) return { error: `Refused: "${to.slice(0, 60)}" is not a single valid recipient address.` };

    const raw = [
      `To: ${to}`,
      `Subject: ${encodeHeader(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
    ].join('\r\n');

    try {
      // POST users/me/drafts — never users/me/messages/send.
      const res = await googleFetch(`${BASE}/drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { raw: encodeB64Url(raw) } }),
      });
      if (!res.ok) {
        const errBody = (await res.text().catch(() => '')).slice(0, 200);
        return { error: `Gmail API HTTP ${res.status}. ${errBody}` };
      }
      const draft = (await res.json()) as { id?: string; message?: { id?: string } };
      return {
        ok: true,
        draftId: draft.id,
        to,
        subject,
        note: 'Draft saved to Gmail. Grace does not send email — open Gmail to review and send it yourself.',
      };
    } catch (e) {
      return googleErrorResult(e);
    }
  },
});
