import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// Warn loudly at startup if a config JSON is malformed. Each loader silently falls back to defaults
// on a parse error, which hides a typo Mikkel made in a config — this surfaces it once, up front.
export function validateConfigs(): void {
  const files = [
    'config/personality.json',
    'config/index-roots.json',
    'config/stt-corrections.json',
    'config/stt-bias.json',
  ];
  let bad = 0;
  for (const rel of files) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    try { JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) {
      bad++;
      console.warn(`[config] ⚠ ${rel} is malformed JSON — Grace is using DEFAULTS for it. Fix: ${String(e).slice(0, 120)}`);
    }
  }
  if (!bad) console.log('[config] all config files parse OK.');
}
