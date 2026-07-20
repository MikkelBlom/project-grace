// ─────────────────────────────────────────────────────────────────────────────
// Undo manager — makes Grace's file mutations reversible (broadest best-effort).
//
// Before any write/edit/move/delete/mkdir, the mutating tool calls the matching before*() here,
// which backs up prior state and pushes a structured entry onto a PERSISTED stack. `undoLast()`
// reverses the most recent action. Grace can call the undo_last tool herself if she realises she
// did something unintended. External/irreversible actions are recorded as not-undoable.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STACK_PATH = path.join(ROOT, 'data', 'undo-stack.json');
const BACKUP_DIR = path.join(ROOT, 'data', 'undo-backups');
const MAX_ENTRIES = 60;

export type UndoType = 'write' | 'edit' | 'delete' | 'move' | 'mkdir' | 'note';

export interface UndoEntry {
  id: string;
  type: UndoType;
  description: string;
  ts: number;
  path?: string;         // affected path (write/edit/delete/mkdir)
  backupPath?: string;   // backup of prior content (write/edit/delete)
  prevExisted?: boolean; // did `path` exist before (write/mkdir)
  from?: string;
  to?: string;           // move
  reversible: boolean;
  undone?: boolean;
}

let counter = 0;
function newId(): string { return `u${Date.now().toString(36)}${(counter++).toString(36)}`; }

class UndoManager {
  private stack: UndoEntry[] = [];

  constructor() { this.load(); }

  private load(): void {
    try { const d = JSON.parse(fs.readFileSync(STACK_PATH, 'utf8')); this.stack = Array.isArray(d.stack) ? d.stack : []; } catch { this.stack = []; }
  }
  private save(): void {
    try { fs.mkdirSync(path.dirname(STACK_PATH), { recursive: true }); fs.writeFileSync(STACK_PATH, JSON.stringify({ stack: this.stack }, null, 2)); } catch { /* best-effort */ }
  }

  /** Copy a file's current bytes to the backup dir; returns the backup path (or undefined if absent). */
  private backup(filePath: string): string | undefined {
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return undefined;
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const bp = path.join(BACKUP_DIR, `${newId()}-${path.basename(filePath)}`);
      fs.copyFileSync(filePath, bp);
      return bp;
    } catch { return undefined; }
  }

  private push(entry: UndoEntry): void {
    this.stack.push(entry);
    // Prune oldest, deleting their backups.
    while (this.stack.length > MAX_ENTRIES) {
      const old = this.stack.shift();
      if (old?.backupPath) { try { fs.unlinkSync(old.backupPath); } catch { /* gone */ } }
    }
    this.save();
  }

  // ── record hooks the file tools call BEFORE mutating ──
  beforeWrite(filePath: string, description: string): void {
    const existed = fs.existsSync(filePath);
    this.push({ id: newId(), type: existed ? 'edit' : 'write', description, ts: Date.now(), path: path.resolve(filePath), backupPath: existed ? this.backup(filePath) : undefined, prevExisted: existed, reversible: true });
  }
  beforeDelete(filePath: string, description: string): void {
    this.push({ id: newId(), type: 'delete', description, ts: Date.now(), path: path.resolve(filePath), backupPath: this.backup(filePath), prevExisted: true, reversible: true });
  }
  beforeMove(from: string, to: string, description: string): void {
    this.push({ id: newId(), type: 'move', description, ts: Date.now(), from: path.resolve(from), to: path.resolve(to), reversible: true });
  }
  beforeMkdir(dirPath: string, description: string): void {
    const existed = fs.existsSync(dirPath);
    this.push({ id: newId(), type: 'mkdir', description, ts: Date.now(), path: path.resolve(dirPath), prevExisted: existed, reversible: !existed });
  }
  /** Record an action that cannot be reversed (external effects), for the history/log only. */
  note(description: string): void {
    this.push({ id: newId(), type: 'note', description, ts: Date.now(), reversible: false });
  }

  history(n = 10): Array<{ id: string; type: UndoType; description: string; when: string; reversible: boolean; undone: boolean }> {
    return this.stack.slice(-n).reverse().map((e) => ({ id: e.id, type: e.type, description: e.description, when: new Date(e.ts).toISOString().slice(0, 19).replace('T', ' '), reversible: e.reversible, undone: !!e.undone }));
  }

  /** Reverse the most recent not-yet-undone, reversible entry. */
  undoLast(): { ok: boolean; undone?: string; error?: string } {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const e = this.stack[i]!;
      if (e.undone) continue;
      if (!e.reversible) return { ok: false, error: `Most recent action isn't reversible: ${e.description}` };
      try {
        this.reverse(e);
        e.undone = true;
        this.save();
        return { ok: true, undone: e.description };
      } catch (err) { return { ok: false, error: `Undo failed: ${String(err).slice(0, 160)}` }; }
    }
    return { ok: false, error: 'nothing to undo' };
  }

  private reverse(e: UndoEntry): void {
    switch (e.type) {
      case 'write': // file was newly created → delete it
        if (e.path && !e.prevExisted && fs.existsSync(e.path)) fs.unlinkSync(e.path);
        break;
      case 'edit':  // restore prior content
      case 'delete': // restore the deleted file
        if (e.path && e.backupPath && fs.existsSync(e.backupPath)) {
          fs.mkdirSync(path.dirname(e.path), { recursive: true });
          fs.copyFileSync(e.backupPath, e.path);
        }
        break;
      case 'move':  // move it back
        if (e.from && e.to && fs.existsSync(e.to)) {
          fs.mkdirSync(path.dirname(e.from), { recursive: true });
          fs.renameSync(e.to, e.from);
        }
        break;
      case 'mkdir': // remove the created folder (only if we created it and it's empty)
        if (e.path && !e.prevExisted && fs.existsSync(e.path)) fs.rmdirSync(e.path);
        break;
    }
  }
}

export const undoManager = new UndoManager();
