// Pure header-safety helpers for the Gmail draft tool — extracted so the CRLF-injection guard can be
// unit-tested. A crafted `to`/`subject` (e.g. from an email Grace is replying to) must not be able to
// smuggle extra headers like a hidden Bcc: into the draft.

/** Strip CR/LF and other control chars so a value can't inject additional RFC822 headers. */
export function stripHeaderCtl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim();
}

/** True if `to` is a single address, optionally "Display Name <addr>" — rejects injected extra recipients. */
export function isSingleRecipient(to: string): boolean {
  return /^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/.test(to) || /^[^<>]+<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>$/.test(to);
}
