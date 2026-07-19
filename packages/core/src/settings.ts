// ─────────────────────────────────────────────────────────────────────────────
// Runtime settings that several subsystems read LIVE — currently the language mode.
//
// "Language mode" is the switch that lets Grace flip between Danish and English:
//   • en  → English STT + English reply + Kokoro (af_heart) voice   (for English-speaking guests)
//   • da  → Danish STT + Danish reply + Danish voice                (Mikkel's default at home)
//
// It's file-backed so a spoken "switch to English" survives restarts. Consumers PULL the
// current value when they need it (OllamaLLM for reply language, KokoroTTS for voice), so no
// event wiring is required; the STT-model reload hooks onto setLanguage() separately.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export type Language = 'da' | 'en';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SETTINGS_PATH = path.join(ROOT, 'data', 'grace-settings.json');

interface SettingsFile {
  language: Language;
}

/** Map many spoken/typed spellings to a canonical language code. Returns null if unrecognised. */
export function parseLanguage(input: string): Language | null {
  const s = String(input ?? '').trim().toLowerCase();
  if (/^(da|dansk|danish|dk|denmark)$/.test(s) || s.includes('dansk') || s.includes('danish')) return 'da';
  if (/^(en|eng|engelsk|english|uk|us)$/.test(s) || s.includes('engelsk') || s.includes('english')) return 'en';
  return null;
}

export function languageName(lang: Language): string {
  return lang === 'da' ? 'Danish' : 'English';
}

function defaultLanguage(): Language {
  // Safe default is English (Kokoro works today). Set GRACE_DEFAULT_LANGUAGE=da in start-grace.ps1
  // once the Danish TTS backend is wired so Danish becomes the at-home default.
  return parseLanguage(process.env.GRACE_DEFAULT_LANGUAGE ?? '') ?? 'en';
}

class Settings {
  private data: SettingsFile;

  constructor() {
    let loaded: Partial<SettingsFile> = {};
    try { loaded = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { /* first run — use defaults */ }
    this.data = { language: loaded.language === 'da' || loaded.language === 'en' ? loaded.language : defaultLanguage() };
  }

  get language(): Language { return this.data.language; }

  /** Set the active language mode (persisted). Returns the resulting language. */
  setLanguage(lang: Language): Language {
    if (lang !== 'da' && lang !== 'en') return this.data.language;
    if (this.data.language !== lang) {
      this.data.language = lang;
      this.persist();
      console.log(`[Settings] language → ${languageName(lang)}`);
    }
    return this.data.language;
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.warn('[Settings] persist failed:', e);
    }
  }
}

export const settings = new Settings();
