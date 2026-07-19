// ─────────────────────────────────────────────────────────────────────────────
// Deterministic post-ASR correction. Speech-to-text reliably mangles a handful of
// names/terms (Grace → "Grys"/"Greis", app names, etc.). Acoustic hotword biasing
// degraded as the list grew, so instead we fix the DECODED TEXT with a small, exact,
// whole-word replacement table that Mikkel curates himself — including by voice via
// the add_stt_correction tool ("when you hear X, I mean Y"). Deterministic and cheap;
// it never touches acoustics, so it can't degrade general recognition.
//
// Kept intentionally conservative: only exact tokens Mikkel adds are replaced, so a
// real word is never silently rewritten unless he asks for it.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CORRECTIONS_PATH = path.join(ROOT, 'config', 'stt-corrections.json');

export interface SttCorrection { from: string; to: string; }

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class SttCorrections {
  private list: SttCorrection[] = [];
  private compiled: Array<{ re: RegExp; to: string }> = [];

  constructor() { this.load(); }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(CORRECTIONS_PATH, 'utf8'));
      this.list = Array.isArray(raw?.corrections)
        ? raw.corrections.filter((c: any) => c && typeof c.from === 'string' && typeof c.to === 'string')
        : [];
    } catch { this.list = []; }
    this.compile();
  }

  private compile(): void {
    this.compiled = this.list
      .filter((c) => c.from.trim() && c.to.trim())
      .map((c) => ({ re: new RegExp(`\\b${escapeRegExp(c.from.trim())}\\b`, 'gi'), to: c.to.trim() }));
  }

  /** Apply all corrections to a decoded transcript (whole-word, case-insensitive). */
  apply(text: string): string {
    if (!text || !this.compiled.length) return text;
    let out = text;
    for (const c of this.compiled) out = out.replace(c.re, c.to);
    return out;
  }

  /** Teach a new correction (idempotent on `from`). Persisted so it survives restarts. */
  add(from: string, to: string): { ok: boolean; error?: string; count?: number } {
    from = String(from ?? '').trim();
    to = String(to ?? '').trim();
    if (!from || !to) return { ok: false, error: 'both from and to are required' };
    if (from.toLowerCase() === to.toLowerCase()) return { ok: false, error: 'from and to are identical' };
    const existing = this.list.find((c) => c.from.toLowerCase() === from.toLowerCase());
    if (existing) existing.to = to; else this.list.push({ from, to });
    this.persist();
    this.compile();
    return { ok: true, count: this.list.length };
  }

  remove(from: string): boolean {
    const before = this.list.length;
    this.list = this.list.filter((c) => c.from.toLowerCase() !== String(from ?? '').trim().toLowerCase());
    if (this.list.length !== before) { this.persist(); this.compile(); return true; }
    return false;
  }

  all(): SttCorrection[] { return [...this.list]; }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(CORRECTIONS_PATH), { recursive: true });
      fs.writeFileSync(CORRECTIONS_PATH, JSON.stringify({ corrections: this.list }, null, 2), 'utf8');
    } catch (e) {
      console.warn('[SttCorrections] persist failed:', e);
    }
  }
}

export const sttCorrections = new SttCorrections();
