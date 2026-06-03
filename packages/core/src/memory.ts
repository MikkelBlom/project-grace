// ─────────────────────────────────────────────
// GraceMemory — conversation persistence across sessions.
//
// Uses Node's built-in `node:sqlite` (no native build — works inside Electron)
// when available, else falls back to a JSON file. Both persist between restarts.
// Stored in grace/data/.
// ─────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data');
const DB_PATH = path.join(DIR, 'grace.db');
const JSON_PATH = path.join(DIR, 'grace-memory.json');

export interface Turn { session: string; role: 'user' | 'grace'; content: string; ts: number; }

interface Backend {
  addTurn(t: Turn): void;
  recentTurns(limit: number): Turn[];
  lastSessionId(exclude: string): string | null;
  lastUserMessageOf(session: string): string | null;
}

function makeSqlite(): Backend | null {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    db.exec(`CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL);`);
    const ins = db.prepare('INSERT INTO turns (session, role, content, ts) VALUES (?, ?, ?, ?)');
    const recent = db.prepare('SELECT session, role, content, ts FROM turns ORDER BY id DESC LIMIT ?');
    const lastSess = db.prepare("SELECT session FROM turns WHERE session != ? ORDER BY id DESC LIMIT 1");
    const lastUser = db.prepare("SELECT content FROM turns WHERE session = ? AND role = 'user' ORDER BY id DESC LIMIT 1");
    return {
      addTurn: (t) => { ins.run(t.session, t.role, t.content, t.ts); },
      recentTurns: (limit) => (recent.all(limit) as Turn[]).reverse(),
      lastSessionId: (ex) => ((lastSess.get(ex) as any)?.session ?? null),
      lastUserMessageOf: (s) => ((lastUser.get(s) as any)?.content ?? null),
    };
  } catch (e) {
    console.warn('[Memory] node:sqlite unavailable -> JSON fallback:', String(e).slice(0, 90));
    return null;
  }
}

function makeJson(): Backend {
  let turns: Turn[] = [];
  try { turns = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')).turns ?? []; } catch { /* fresh */ }
  const save = () => { try { fs.writeFileSync(JSON_PATH, JSON.stringify({ turns })); } catch { /* ignore */ } };
  return {
    addTurn: (t) => { turns.push(t); save(); },
    recentTurns: (limit) => turns.slice(-limit),
    lastSessionId: (ex) => { for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.session !== ex) return turns[i]!.session; return null; },
    lastUserMessageOf: (s) => { for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.session === s && turns[i]!.role === 'user') return turns[i]!.content; return null; },
  };
}

export class GraceMemory {
  private be: Backend;
  readonly engine: 'sqlite' | 'json';
  constructor() {
    fs.mkdirSync(DIR, { recursive: true });
    const sq = makeSqlite();
    this.be = sq ?? makeJson();
    this.engine = sq ? 'sqlite' : 'json';
    console.log(`[Memory] persistence: ${this.engine} (${DIR})`);
  }
  addTurn(session: string, role: 'user' | 'grace', content: string): void {
    if (!content?.trim()) return;
    try { this.be.addTurn({ session, role, content: content.trim(), ts: Date.now() }); }
    catch (e) { console.warn('[Memory] addTurn failed:', e); }
  }
  recentTurns(limit = 8): Turn[] { try { return this.be.recentTurns(limit); } catch { return []; } }
  /** Last user message from the previous (different) session — for startup recall. */
  lastSessionRecall(currentSession: string): string | null {
    try {
      const sid = this.be.lastSessionId(currentSession);
      return sid ? this.be.lastUserMessageOf(sid) : null;
    } catch { return null; }
  }
}
