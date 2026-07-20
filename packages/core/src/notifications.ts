// Notification center — accumulates Grace's proactive alerts (every `overlay:notification` event)
// into a rolling, persisted log Mikkel can review. A renderer can later surface these visually; the
// data layer is here and non-breaking.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { bus } from './EventBus.js';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const N_PATH = path.join(ROOT, 'data', 'notifications.json');

interface Note { text: string; level: string; ts: number; }

class NotificationCenter {
  private list: Note[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
    bus.on('overlay:notification', (n: any) => this.add(n?.text ?? '', n?.level ?? 'info'));
    process.once('exit', () => this.flush());
    process.once('beforeExit', () => this.flush());
  }

  private load(): void { try { const d = JSON.parse(fs.readFileSync(N_PATH, 'utf8')); this.list = Array.isArray(d.notes) ? d.notes : []; } catch { this.list = []; } }
  private flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try { fs.mkdirSync(path.dirname(N_PATH), { recursive: true }); fs.writeFileSync(N_PATH, JSON.stringify({ notes: this.list.slice(-100) }, null, 2)); } catch { /* best-effort */ }
  }
  // Debounced: a mission's per-item announcements would otherwise trigger a synchronous whole-file
  // rewrite per event on the main thread. Coalesce; the log is a convenience store, not source-of-truth.
  private save(): void { if (this.saveTimer) return; this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 1000); }

  private add(text: string, level: string): void {
    if (!text) return;
    this.list.push({ text: String(text), level: String(level), ts: Date.now() });
    if (this.list.length > 100) this.list = this.list.slice(-100);
    this.save();
  }

  recent(n = 20): Array<{ text: string; level: string; when: string }> {
    return this.list.slice(-n).reverse().map((x) => ({ text: x.text, level: x.level, when: new Date(x.ts).toISOString().slice(0, 16).replace('T', ' ') }));
  }
  clear(): void { this.list = []; this.flush(); }
}

export const notificationCenter = new NotificationCenter();
