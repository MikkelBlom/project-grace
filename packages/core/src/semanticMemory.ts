// ─────────────────────────────────────────────
// Grace semantic memory + working memory
//
// Stores turns locally, mirrors semantic records to ChromaDB when available,
// and keeps a persistent mission/task scratchpad plus an evolving user profile.
// ─────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DATA_DIR = path.join(ROOT, 'data');
const SCRATCHPAD_DIR = path.join(DATA_DIR, 'scratchpads');
const TURN_DB_PATH = path.join(DATA_DIR, 'grace.db');
const TURN_JSON_PATH = path.join(DATA_DIR, 'grace-memory.json');
const SEMANTIC_JSON_PATH = path.join(DATA_DIR, 'grace-semantic-memory.json');
const STATE_JSON_PATH = path.join(DATA_DIR, 'grace-memory-state.json');
const CHROMA_COMPOSE_PATH = path.join(ROOT, 'docker', 'chroma', 'docker-compose.yml');

const OLLAMA_URL = process.env.GRACE_OLLAMA_URL ?? 'http://localhost:11434';
const EMBED_MODEL = process.env.GRACE_EMBED_MODEL ?? 'nomic-embed-text';
const CHROMA_URL = process.env.GRACE_CHROMA_URL ?? 'http://127.0.0.1:8000';

const COLLECTION_MAP: Record<string, string> = {
  conversation: 'conversation_history',
  profile: 'user_profile',
  task: 'mission_artifacts',
  mission: 'mission_artifacts',
  scratchpad: 'mission_artifacts',
  personality: 'personality_traits',
};

export type TurnRole = 'user' | 'grace';
export type MemoryNamespace = 'conversation' | 'profile' | 'task' | 'mission' | 'scratchpad' | 'personality';
export type MemoryKind = 'turn' | 'summary' | 'fact' | 'result' | 'plan' | 'note' | 'preference' | 'trait' | 'file' | 'profile';
export type WorkspaceKind = 'task' | 'mission';
export type WorkspaceStatus = 'planning' | 'active' | 'paused' | 'done' | 'failed' | 'cancelled';

export interface Turn {
  session: string;
  role: TurnRole;
  content: string;
  ts: number;
}

export interface SemanticRecord {
  id: string;
  namespace: MemoryNamespace;
  kind: MemoryKind;
  text: string;
  summary: string;
  source?: string;
  sessionId?: string;
  workspaceId?: string;
  objective?: string;
  tags: string[];
  importance: number;
  relatedIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MemorySearchHit {
  id: string;
  namespace: MemoryNamespace;
  kind: MemoryKind;
  summary: string;
  text: string;
  source?: string;
  sessionId?: string;
  workspaceId?: string;
  objective?: string;
  tags: string[];
  importance: number;
  score: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProfileFact {
  key: string;
  category: string;
  text: string;
  source: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface UserProfileState {
  facts: ProfileFact[];
  lastUpdated: number;
}

export interface ScratchpadState {
  id: string;
  kind: WorkspaceKind;
  objective: string;
  status: WorkspaceStatus;
  plan: string[];
  currentStep: string;
  completedSteps: string[];
  artifacts: string[];
  filePaths: string[];
  hypotheses: string[];
  openRisks: string[];
  verification: string[];
  notes: string[];
  summary: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScratchpadPatch {
  objective?: string;
  status?: WorkspaceStatus;
  plan?: string[];
  currentStep?: string;
  completedSteps?: string[];
  artifacts?: string[];
  filePaths?: string[];
  hypotheses?: string[];
  openRisks?: string[];
  verification?: string[];
  notes?: string[];
  summary?: string;
  reset?: boolean;
}

interface StateFile {
  activeWorkspaceId: string | null;
  profile: UserProfileState;
}

interface Backend {
  addTurn(t: Turn): void;
  recentTurns(limit: number): Turn[];
  lastSessionId(exclude: string): string | null;
  lastUserMessageOf(session: string): string | null;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: unknown): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  } catch (error) {
    console.warn('[Memory] writeJson failed:', error);
  }
}

function shortSummary(text: string, max = 240): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max);
  const cut = Math.max(slice.lastIndexOf('.'), slice.lastIndexOf('!'), slice.lastIndexOf('?'), slice.lastIndexOf(' '));
  return `${slice.slice(0, Math.max(cut, max * 0.6)).trim()}...`;
}

function uniqueItems(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const value = String(item ?? '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function mergeStringArrays(base: string[] = [], patch: string[] = []): string[] {
  return uniqueItems([...base, ...patch]);
}

function normalizeWhitespace(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  return normalizeWhitespace(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 2);
}

function scoreRecency(createdAt: number, updatedAt: number): number {
  const ageHours = Math.max(0, (Date.now() - Math.max(createdAt, updatedAt)) / 3_600_000);
  return 1 / (1 + ageHours);
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeWorkspaceFile(id: string): string {
  return path.join(SCRATCHPAD_DIR, `${id}.json`);
}

function safeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function extractPreferenceFacts(text: string): Array<{ category: string; text: string }> {
  const raw = normalizeWhitespace(text);
  if (!raw) return [];
  const lowered = raw.toLowerCase();
  const patterns: Array<[RegExp, string]> = [
    [/\b(i like|i love|i prefer|i hate|my favorite|my favourite)\b/i, 'preference'],
    [/\b(i use|i work with|my stack|my code style|my formatting|my format preference)\b/i, 'workflow'],
    [/\b(i eat|i usually eat|i often eat|when i eat|my eating)\b/i, 'routine'],
    [/\b(i live|i store|my projects|my files|my friends|my family|my people)\b/i, 'context'],
    [/\b(i want|i need|i do not want|don't want|never want|always want)\b/i, 'preference'],
  ];
  const out: Array<{ category: string; text: string }> = [];
  for (const [pattern, category] of patterns) {
    if (pattern.test(lowered)) {
      out.push({ category, text: raw });
      break;
    }
  }
  return out;
}

class BackendStore {
  private db: Backend | null = null;
  readonly engine: 'sqlite' | 'json';

  constructor() {
    ensureDir(DATA_DIR);
    this.db = this.makeSqlite();
    this.engine = this.db ? 'sqlite' : 'json';
    if (!this.db) {
      console.warn('[Memory] node:sqlite unavailable -> JSON fallback');
    }
  }

  private makeSqlite(): Backend | null {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(TURN_DB_PATH);
      db.exec(`CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        ts INTEGER NOT NULL
      );`);
      const ins = db.prepare('INSERT INTO turns (session, role, content, ts) VALUES (?, ?, ?, ?)');
      const recent = db.prepare('SELECT session, role, content, ts FROM turns ORDER BY id DESC LIMIT ?');
      const lastSess = db.prepare('SELECT session FROM turns WHERE session != ? ORDER BY id DESC LIMIT 1');
      const lastUser = db.prepare("SELECT content FROM turns WHERE session = ? AND role = 'user' ORDER BY id DESC LIMIT 1");
      return {
        addTurn: (t) => { ins.run(t.session, t.role, t.content, t.ts); },
        recentTurns: (limit) => (recent.all(limit) as Turn[]).reverse(),
        lastSessionId: (exclude) => ((lastSess.get(exclude) as { session?: string } | undefined)?.session ?? null),
        lastUserMessageOf: (session) => ((lastUser.get(session) as { content?: string } | undefined)?.content ?? null),
      };
    } catch (error) {
      console.warn('[Memory] sqlite backend unavailable:', String(error).slice(0, 120));
      return null;
    }
  }

  addTurn(turn: Turn): void {
    if (!turn.content?.trim()) return;
    try {
      if (this.db) this.db.addTurn(turn);
      else this.saveJson(turn);
    } catch (error) {
      console.warn('[Memory] addTurn failed:', error);
    }
  }

  private saveJson(turn: Turn): void {
    const current = readJson<{ turns: Turn[] }>(TURN_JSON_PATH, { turns: [] });
    current.turns.push(turn);
    writeJson(TURN_JSON_PATH, current);
  }

  recentTurns(limit = 8): Turn[] {
    try {
      if (this.db) return this.db.recentTurns(limit);
      const current = readJson<{ turns: Turn[] }>(TURN_JSON_PATH, { turns: [] });
      return current.turns.slice(-limit);
    } catch {
      return [];
    }
  }

  lastSessionRecall(currentSession: string): string | null {
    try {
      const sid = this.db?.lastSessionId(currentSession) ?? null;
      if (sid && this.db) return this.db.lastUserMessageOf(sid);
      const current = readJson<{ turns: Turn[] }>(TURN_JSON_PATH, { turns: [] });
      for (let i = current.turns.length - 1; i >= 0; i--) {
        if (current.turns[i]!.session !== currentSession) {
          const session = current.turns[i]!.session;
          for (let j = current.turns.length - 1; j >= 0; j--) {
            if (current.turns[j]!.session === session && current.turns[j]!.role === 'user') return current.turns[j]!.content;
          }
          break;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}

class ChromaBridge {
  private ready = false;
  private collectionIds = new Map<string, string>();
  private initPromise: Promise<boolean> | null = null;
  private warned = false;

  private async fetchJson(url: string, init?: RequestInit): Promise<any> {
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }

  private async heartbeat(): Promise<boolean> {
    const urls = [
      `${CHROMA_URL}/api/v1/heartbeat`,
      `${CHROMA_URL}/api/v2/heartbeat`,
      `${CHROMA_URL}/heartbeat`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) return true;
      } catch {
        // try next endpoint
      }
    }
    return false;
  }

  private startDocker(): boolean {
    if (!fs.existsSync(CHROMA_COMPOSE_PATH)) return false;
    try {
      const result = spawnSync('docker', ['compose', '-f', CHROMA_COMPOSE_PATH, 'up', '-d'], {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (result.status === 0) return true;
      if (!this.warned) {
        console.warn('[Memory] Chroma auto-start failed:', String(result.stderr || result.stdout || '').slice(0, 300));
        this.warned = true;
      }
      return false;
    } catch (error) {
      if (!this.warned) {
        console.warn('[Memory] Chroma auto-start unavailable:', String(error).slice(0, 200));
        this.warned = true;
      }
      return false;
    }
  }

  async ensureReady(): Promise<boolean> {
    if (this.ready) return true;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      if (await this.heartbeat()) {
        this.ready = true;
        return true;
      }
      this.startDocker();
      let logged = false;
      while (true) {
        if (await this.heartbeat()) {
          this.ready = true;
          if (logged) console.log('[Memory] ChromaDB is now online.');
          return true;
        }
        if (!logged) {
          console.warn('[Memory] Waiting for ChromaDB to start (Hard Dependency)...');
          logged = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    })();
    const result = await this.initPromise;
    this.initPromise = null;
    return result;
  }

  private async getCollectionId(namespace: string): Promise<string | null> {
    const colName = COLLECTION_MAP[namespace] || 'grace_memory';
    if (this.collectionIds.has(colName)) return this.collectionIds.get(colName)!;
    if (!(await this.ensureReady())) return null;

    try {
      const list = await this.fetchJson(`${CHROMA_URL}/api/v1/collections`);
      const items = Array.isArray(list) ? list : (Array.isArray(list?.collections) ? list.collections : []);
      const match = items.find((item: any) => item?.name === colName || item?.id || item?.collection_id);
      const id = match?.id ?? match?.collection_id ?? match?.name ?? null;
      if (id) {
        this.collectionIds.set(colName, String(id));
        return String(id);
      }
    } catch {
      // try create below
    }

    try {
      const created = await this.fetchJson(`${CHROMA_URL}/api/v1/collections`, {
        method: 'POST',
        body: JSON.stringify({ name: colName }),
      });
      const id = created?.id ?? created?.collection_id ?? created?.name ?? colName;
      this.collectionIds.set(colName, String(id));
      return String(id);
    } catch (error) {
      if (!this.warned) {
        console.warn(`[Memory] Chroma collection init failed for ${colName}:`, String(error).slice(0, 220));
        this.warned = true;
      }
      return null;
    }
  }

  private async embed(text: string): Promise<number[]> {
    let retries = 0;
    while (true) {
      try {
        const result = await this.fetchJson(`${OLLAMA_URL}/api/embeddings`, {
          method: 'POST',
          body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
          signal: AbortSignal.timeout(20_000),
        });
        const embedding = result?.embedding;
        if (Array.isArray(embedding)) return embedding.map((v: any) => Number(v) || 0);
        throw new Error('Invalid embedding format from Ollama');
      } catch (error) {
        retries++;
        if (retries > 3) throw new Error(`[Memory] Ollama embeddings failed permanently: ${String(error)}`);
        console.warn(`[Memory] embeddings request failed, retrying (${retries}/3)...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  async upsert(record: SemanticRecord): Promise<void> {
    const collectionId = await this.getCollectionId(record.namespace);
    if (!collectionId) return;
    try {
      const embedding = await this.embed(`${record.summary}\n\n${record.text}`);
      await this.fetchJson(`${CHROMA_URL}/api/v1/collections/${encodeURIComponent(collectionId)}/add`, {
        method: 'POST',
        body: JSON.stringify({
          ids: [record.id],
          embeddings: [embedding],
          metadatas: [this.toMetadata(record)],
          documents: [this.toDocument(record)],
        }),
      });
    } catch (error) {
      if (!this.warned) {
        console.warn('[Memory] Chroma upsert failed:', String(error).slice(0, 220));
        this.warned = true;
      }
    }
  }

  async query(query: string, limit: number, namespace: string): Promise<Array<{ id: string; score: number; metadata: any; document: string }>> {
    const collectionId = await this.getCollectionId(namespace);
    if (!collectionId) return [];
    try {
      const embedding = await this.embed(query);
      const result = await this.fetchJson(`${CHROMA_URL}/api/v1/collections/${encodeURIComponent(collectionId)}/query`, {
        method: 'POST',
        body: JSON.stringify({
          query_embeddings: [embedding],
          n_results: limit,
          include: ['metadatas', 'documents', 'distances'],
        }),
      });
      // v2 may return different shapes — normalize defensively
      const ids = result?.ids?.[0] ?? result?.result?.ids ?? [];
      const documents = result?.documents?.[0] ?? result?.result?.documents ?? [];
      const metadatas = result?.metadatas?.[0] ?? result?.result?.metadatas ?? [];
      const distances = result?.distances?.[0] ?? result?.result?.distances ?? [];
      return (Array.isArray(ids) ? ids : []).map((id: string, index: number) => ({
        id,
        score: Math.max(0, 1 - Number(distances[index] ?? 1)),
        metadata: metadatas[index] ?? {},
        document: String((documents[index] ?? '') || ''),
      }));
    } catch (error) {
      if (!this.warned) {
        console.warn('[Memory] Chroma query failed:', String(error).slice(0, 220));
        this.warned = true;
      }
      return [];
    }
  }

  private toMetadata(record: SemanticRecord): Record<string, unknown> {
    return {
      namespace: record.namespace,
      kind: record.kind,
      summary: record.summary,
      source: record.source ?? '',
      sessionId: record.sessionId ?? '',
      workspaceId: record.workspaceId ?? '',
      objective: record.objective ?? '',
      tags: record.tags,
      importance: record.importance,
      relatedIds: record.relatedIds,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private toDocument(record: SemanticRecord): string {
    return [
      `summary: ${record.summary}`,
      record.source ? `source: ${record.source}` : '',
      record.objective ? `objective: ${record.objective}` : '',
      `text: ${record.text}`,
    ].filter(Boolean).join('\n');
  }
}

function scoreLocalRecord(queryTokens: Set<string>, record: SemanticRecord): number {
  const recordTokens = new Set(tokenize(`${record.summary}\n${record.text}\n${record.tags.join(' ')}`));
  let overlap = 0;
  for (const token of queryTokens) {
    if (recordTokens.has(token)) overlap += 1;
  }
  const coverage = queryTokens.size ? overlap / queryTokens.size : 0;
  const recency = scoreRecency(record.createdAt, record.updatedAt);
  const importance = Math.min(1, Math.max(0, record.importance));
  return (coverage * 0.55) + (recency * 0.25) + (importance * 0.20);
}

export class GraceMemory {
  readonly engine: 'sqlite' | 'json';
  readonly semanticEngine: 'chroma' | 'local';
  private backend: BackendStore;
  private chroma = new ChromaBridge();
  private semanticJournal: SemanticRecord[] = [];
  private state: StateFile;
  private activeWorkspace: ScratchpadState | null = null;
  private stateLoaded = false;

  constructor() {
    ensureDir(DATA_DIR);
    ensureDir(SCRATCHPAD_DIR);
    this.backend = new BackendStore();
    this.engine = this.backend.engine;
    this.state = this.loadState();
    this.semanticJournal = this.loadSemanticJournal();
    this.semanticEngine = 'chroma';
    this.restoreActiveWorkspace();
    void this.chroma.ensureReady();
    console.log(`[Memory] persistence: ${this.engine} (${DATA_DIR})`);
  }

  private loadState(): StateFile {
    const fallback: StateFile = {
      activeWorkspaceId: null,
      profile: { facts: [], lastUpdated: Date.now() },
    };
    const loaded = readJson<StateFile>(STATE_JSON_PATH, fallback);
    return {
      activeWorkspaceId: loaded.activeWorkspaceId ?? null,
      profile: {
        facts: Array.isArray(loaded.profile?.facts) ? loaded.profile.facts : [],
        lastUpdated: loaded.profile?.lastUpdated ?? Date.now(),
      },
    };
  }

  private loadSemanticJournal(): SemanticRecord[] {
    const loaded = readJson<{ records: SemanticRecord[] }>(SEMANTIC_JSON_PATH, { records: [] });
    return Array.isArray(loaded.records) ? loaded.records : [];
  }

  private saveState(): void {
    writeJson(STATE_JSON_PATH, this.state);
    this.stateLoaded = true;
  }

  private saveSemanticJournal(): void {
    writeJson(SEMANTIC_JSON_PATH, { records: this.semanticJournal });
  }

  private persistWorkspace(workspace: ScratchpadState): void {
    ensureDir(SCRATCHPAD_DIR);
    writeJson(makeWorkspaceFile(workspace.id), workspace);
    this.activeWorkspace = workspace;
    this.state.activeWorkspaceId = workspace.id;
    this.saveState();
  }

  private restoreActiveWorkspace(): void {
    const id = this.state.activeWorkspaceId;
    if (!id) return;
    const filePath = makeWorkspaceFile(id);
    if (!fs.existsSync(filePath)) return;
    const workspace = readJson<ScratchpadState | null>(filePath, null as ScratchpadState | null);
    if (workspace) {
      this.activeWorkspace = workspace;
    }
  }

  private createWorkspace(kind: WorkspaceKind, objective: string, id = makeId(kind)): ScratchpadState {
    const workspace: ScratchpadState = {
      id,
      kind,
      objective: objective.trim(),
      status: 'planning',
      plan: [],
      currentStep: '',
      completedSteps: [],
      artifacts: [],
      filePaths: [],
      hypotheses: [],
      openRisks: [],
      verification: [],
      notes: [],
      summary: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.persistWorkspace(workspace);
    return workspace;
  }

  private normalizeScratchpadPatch(patch: ScratchpadPatch): ScratchpadPatch {
    return {
      ...patch,
      plan: safeStringList(patch.plan),
      completedSteps: safeStringList(patch.completedSteps),
      artifacts: safeStringList(patch.artifacts),
      filePaths: safeStringList(patch.filePaths),
      hypotheses: safeStringList(patch.hypotheses),
      openRisks: safeStringList(patch.openRisks),
      verification: safeStringList(patch.verification),
      notes: safeStringList(patch.notes),
    };
  }

  addTurn(session: string, role: TurnRole, content: string): void {
    const clean = String(content ?? '').trim();
    if (!clean) return;
    const turn: Turn = { session, role, content: clean, ts: Date.now() };
    this.backend.addTurn(turn);
    const record: SemanticRecord = {
      id: makeId('turn'),
      namespace: 'conversation',
      kind: 'turn',
      text: clean,
      summary: shortSummary(clean),
      source: `session:${session}:${role}`,
      sessionId: session,
      tags: [role, 'turn'],
      importance: role === 'user' ? 0.8 : 0.5,
      relatedIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.addSemanticRecord(record);
    if (role === 'user') {
      const facts = extractPreferenceFacts(clean);
      if (facts.length) {
        this.updateUserProfile({
          facts: facts.map((fact) => ({
            category: fact.category,
            text: fact.text,
            source: `session:${session}`,
            confidence: 0.55,
          })),
        });
      }
    }
  }

  recentTurns(limit = 8): Turn[] {
    return this.backend.recentTurns(limit);
  }

  lastSessionRecall(currentSession: string): string | null {
    return this.backend.lastSessionRecall(currentSession);
  }

  startWorkspace(kind: WorkspaceKind, objective: string, id?: string): ScratchpadState {
    const workspace = this.createWorkspace(kind, objective, id);
    this.persistWorkspace(workspace);
    this.addSemanticRecord({
      id: makeId('workspace'),
      namespace: kind,
      kind: 'plan',
      text: `Workspace opened for ${kind}: ${objective}`,
      summary: shortSummary(objective),
      source: `workspace:${workspace.id}`,
      workspaceId: workspace.id,
      objective,
      tags: [kind, 'workspace', 'start'],
      importance: 0.9,
      relatedIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return workspace;
  }

  getActiveWorkspace(): ScratchpadState | null {
    if (this.activeWorkspace) return JSON.parse(JSON.stringify(this.activeWorkspace)) as ScratchpadState;
    const id = this.state.activeWorkspaceId;
    if (!id) return null;
    const filePath = makeWorkspaceFile(id);
    if (!fs.existsSync(filePath)) return null;
    const workspace = readJson<ScratchpadState | null>(filePath, null as ScratchpadState | null);
    if (workspace) {
      this.activeWorkspace = workspace;
      return JSON.parse(JSON.stringify(workspace)) as ScratchpadState;
    }
    return null;
  }

  updateScratchpad(patch: ScratchpadPatch, source = 'tool'): ScratchpadState {
    const normalized = this.normalizeScratchpadPatch(patch);
    const workspace = this.activeWorkspace ?? this.startWorkspace('task', normalized.objective ?? 'Untitled task');
    if (normalized.reset) {
      workspace.plan = [];
      workspace.completedSteps = [];
      workspace.artifacts = [];
      workspace.filePaths = [];
      workspace.hypotheses = [];
      workspace.openRisks = [];
      workspace.verification = [];
      workspace.notes = [];
      workspace.currentStep = '';
      workspace.summary = '';
    }
    if (normalized.objective) workspace.objective = normalized.objective.trim();
    if (normalized.status) workspace.status = normalized.status;
    if (normalized.plan?.length) workspace.plan = mergeStringArrays(workspace.plan, normalized.plan);
    if (normalized.currentStep !== undefined) workspace.currentStep = normalized.currentStep.trim();
    if (normalized.completedSteps?.length) workspace.completedSteps = mergeStringArrays(workspace.completedSteps, normalized.completedSteps);
    if (normalized.artifacts?.length) workspace.artifacts = mergeStringArrays(workspace.artifacts, normalized.artifacts);
    if (normalized.filePaths?.length) workspace.filePaths = mergeStringArrays(workspace.filePaths, normalized.filePaths);
    if (normalized.hypotheses?.length) workspace.hypotheses = mergeStringArrays(workspace.hypotheses, normalized.hypotheses);
    if (normalized.openRisks?.length) workspace.openRisks = mergeStringArrays(workspace.openRisks, normalized.openRisks);
    if (normalized.verification?.length) workspace.verification = mergeStringArrays(workspace.verification, normalized.verification);
    if (normalized.notes?.length) workspace.notes = mergeStringArrays(workspace.notes, normalized.notes);
    if (normalized.summary !== undefined) workspace.summary = normalized.summary.trim();
    workspace.updatedAt = Date.now();
    this.persistWorkspace(workspace);
    this.addSemanticRecord({
      id: makeId('scratchpad'),
      namespace: workspace.kind,
      kind: 'note',
      text: JSON.stringify({
        objective: workspace.objective,
        status: workspace.status,
        currentStep: workspace.currentStep,
        plan: workspace.plan,
        completedSteps: workspace.completedSteps,
        artifacts: workspace.artifacts,
        filePaths: workspace.filePaths,
        hypotheses: workspace.hypotheses,
        openRisks: workspace.openRisks,
        verification: workspace.verification,
        notes: workspace.notes,
      }),
      summary: workspace.summary || shortSummary(workspace.currentStep || workspace.objective),
      source: `scratchpad:${workspace.id}:${source}`,
      workspaceId: workspace.id,
      objective: workspace.objective,
      tags: [workspace.kind, 'scratchpad', workspace.status],
      importance: 0.95,
      relatedIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return JSON.parse(JSON.stringify(workspace)) as ScratchpadState;
  }

  completeWorkspace(status: Exclude<WorkspaceStatus, 'planning' | 'active'>, summary = ''): void {
    const workspace = this.getActiveWorkspace();
    if (!workspace) return;
    workspace.status = status;
    if (summary) workspace.summary = summary;
    workspace.updatedAt = Date.now();
    this.persistWorkspace(workspace);
  }

  updateUserProfile(patch: {
    facts?: Array<{ category: string; text: string; source?: string; confidence?: number }>;
    notes?: string[];
  }): UserProfileState {
    const facts = this.state.profile.facts.slice();
    const now = Date.now();
    for (const item of patch.facts ?? []) {
      const text = normalizeWhitespace(item.text);
      if (!text) continue;
      const key = `${normalizeWhitespace(item.category || 'general').toLowerCase()}:${text.toLowerCase()}`;
      const existing = facts.find((fact) => fact.key === key);
      if (existing) {
        existing.text = text;
        existing.category = normalizeWhitespace(item.category || existing.category);
        existing.source = item.source ?? existing.source;
        existing.confidence = Math.max(existing.confidence, item.confidence ?? 0.5);
        existing.updatedAt = now;
      } else {
        facts.push({
          key,
          category: normalizeWhitespace(item.category || 'general'),
          text,
          source: normalizeWhitespace(item.source || 'manual'),
          confidence: Math.max(0, Math.min(1, item.confidence ?? 0.6)),
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    for (const note of patch.notes ?? []) {
      const text = normalizeWhitespace(note);
      if (!text) continue;
      const key = `note:${text.toLowerCase()}`;
      if (facts.some((fact) => fact.key === key)) continue;
      facts.push({
        key,
        category: 'note',
        text,
        source: 'manual',
        confidence: 0.4,
        createdAt: now,
        updatedAt: now,
      });
    }
    this.state.profile = { facts, lastUpdated: now };
    this.saveState();
    for (const fact of patch.facts ?? []) {
      const text = normalizeWhitespace(fact.text);
      if (!text) continue;
      void this.addSemanticRecord({
        id: makeId('profile'),
        namespace: 'profile',
        kind: 'fact',
        text,
        summary: shortSummary(text),
        source: normalizeWhitespace(fact.source || 'manual'),
        tags: [normalizeWhitespace(fact.category || 'general'), 'profile'],
        importance: Math.max(0.5, fact.confidence ?? 0.6),
        relatedIds: [],
        createdAt: now,
        updatedAt: now,
      });
    }
    return JSON.parse(JSON.stringify(this.state.profile)) as UserProfileState;
  }

  getUserProfile(limit = 12): UserProfileState {
    const facts = this.state.profile.facts
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
    return { facts: JSON.parse(JSON.stringify(facts)) as ProfileFact[], lastUpdated: this.state.profile.lastUpdated };
  }

  private addSemanticRecord(record: SemanticRecord): void {
    this.semanticJournal.push(record);
    if (this.semanticJournal.length > 10_000) {
      this.semanticJournal = this.semanticJournal.slice(-8_000);
    }
    this.saveSemanticJournal();
    void this.chroma.upsert(record);
  }

  async search(query: string, options: { limit?: number; namespace?: MemoryNamespace | 'all' | MemoryNamespace[]; minScore?: number; recencyWeight?: number; } = {}): Promise<MemorySearchHit[]> {
    const clean = normalizeWhitespace(query);
    const namespaces: string[] = options.namespace && options.namespace !== 'all'
      ? (Array.isArray(options.namespace) ? options.namespace : [options.namespace])
      : ['conversation', 'profile', 'task', 'personality'];
    
    const minScore = typeof options.minScore === 'number' ? options.minScore : 0.40;
    const recencyWeight = Math.max(0, Math.min(1, typeof options.recencyWeight === 'number' ? options.recencyWeight : 0.25));

    const chromaHits: any[] = [];
    for (const ns of namespaces) {
      const hits = await this.chroma.query(clean, 50, ns);
      chromaHits.push(...hits);
    }
    
    const chromaCandidates = chromaHits
      .map((hit) => ({
        id: hit.id,
        namespace: (hit.metadata?.namespace ?? 'conversation') as MemoryNamespace,
        kind: (hit.metadata?.kind ?? 'turn') as MemoryKind,
        summary: String(hit.metadata?.summary ?? shortSummary(hit.document)),
        text: String(hit.document ?? ''),
        source: hit.metadata?.source ? String(hit.metadata.source) : undefined,
        sessionId: hit.metadata?.sessionId ? String(hit.metadata.sessionId) : undefined,
        workspaceId: hit.metadata?.workspaceId ? String(hit.metadata.workspaceId) : undefined,
        objective: hit.metadata?.objective ? String(hit.metadata.objective) : undefined,
        tags: Array.isArray(hit.metadata?.tags) ? hit.metadata.tags.map((tag: any) => String(tag)) : [],
        importance: Number(hit.metadata?.importance ?? 0.5),
        score: Number(hit.score ?? 0),
        createdAt: Number(hit.metadata?.createdAt ?? Date.now()),
        updatedAt: Number(hit.metadata?.updatedAt ?? Date.now()),
      }));

    const queryTokens = new Set(tokenize(clean));
    const localCandidates = this.semanticJournal.filter((record) => namespaces.includes(record.namespace));
    const localHits = localCandidates
      .map((record) => ({
        id: record.id,
        namespace: record.namespace,
        kind: record.kind,
        summary: record.summary,
        text: record.text,
        source: record.source,
        sessionId: record.sessionId,
        workspaceId: record.workspaceId,
        objective: record.objective,
        tags: record.tags,
        importance: record.importance,
        score: scoreLocalRecord(queryTokens, record),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }))
      .filter((hit) => hit.score >= minScore);

    const combined = new Map<string, MemorySearchHit>();
    for (const hit of [...chromaCandidates, ...localHits]) {
      const recency = scoreRecency(hit.createdAt, hit.updatedAt);
      const adjustedScore = ((1 - recencyWeight) * (hit.score ?? 0)) + (recencyWeight * recency);
      if (adjustedScore < minScore) continue;
      const enriched: MemorySearchHit = { ...hit, score: adjustedScore } as MemorySearchHit;
      const current = combined.get(enriched.id);
      if (!current || enriched.score > current.score) combined.set(enriched.id, enriched);
    }

    return [...combined.values()]
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
      .slice(0, 80);
  }

  private workspaceBlock(workspace: ScratchpadState): string {
    return [
      `WORKING MEMORY — current ${workspace.kind} scratchpad (persistent, resume from here if you were interrupted):`,
      `- Workspace ID: ${workspace.id}`,
      `- Objective: ${workspace.objective}`,
      `- Status: ${workspace.status}`,
      workspace.currentStep ? `- Current step: ${workspace.currentStep}` : '',
      workspace.summary ? `- Summary: ${workspace.summary}` : '',
      workspace.plan.length ? `- Plan: ${workspace.plan.map((step, index) => `${index + 1}. ${step}`).join(' | ')}` : '',
      workspace.completedSteps.length ? `- Completed: ${workspace.completedSteps.join(' | ')}` : '',
      workspace.artifacts.length ? `- Artifacts: ${workspace.artifacts.join(' | ')}` : '',
      workspace.filePaths.length ? `- File paths: ${workspace.filePaths.join(' | ')}` : '',
      workspace.hypotheses.length ? `- Hypotheses: ${workspace.hypotheses.join(' | ')}` : '',
      workspace.openRisks.length ? `- Open risks: ${workspace.openRisks.join(' | ')}` : '',
      workspace.verification.length ? `- Verification: ${workspace.verification.join(' | ')}` : '',
      workspace.notes.length ? `- Notes: ${workspace.notes.join(' | ')}` : '',
    ].filter(Boolean).join('\n');
  }

  private profileBlock(profile: UserProfileState): string {
    const facts = profile.facts.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
    if (!facts.length) return '';
    return [
      'LONG-TERM USER PROFILE — facts learned about Mikkel (latest wins if facts conflict):',
      ...facts.map((fact) => `- [${fact.category}] ${fact.text} (source: ${fact.source}, confidence: ${Math.round(fact.confidence * 100)}%)`),
    ].join('\n');
  }

  private memoryBlock(hits: MemorySearchHit[]): string {
    if (!hits.length) return '';
    return [
      'LONG-TERM SEMANTIC MEMORY — relevant retrieved context (use only what helps):',
      ...hits.map((hit, index) => {
        const prefix = `#${index + 1} [${hit.namespace}/${hit.kind}]`;
        const source = hit.source ? ` source=${hit.source}` : '';
        const context = hit.objective ? ` objective=${hit.objective}` : '';
        const tags = hit.tags.length ? ` tags=${hit.tags.join(',')}` : '';
        return `- ${prefix} ${hit.summary}${source}${context}${tags}`;
      }),
    ].join('\n');
  }

  async buildPromptBlocks(query: string, options: { includeProfile?: boolean; includeWorkspace?: boolean; namespace?: MemoryNamespace | 'all'; limit?: number } = {}): Promise<string[]> {
    const blocks: string[] = [];
    const workspace = options.includeWorkspace === false ? null : this.getActiveWorkspace();
    if (workspace) blocks.push(this.workspaceBlock(workspace));
    if (options.includeProfile !== false) {
      const profile = this.getUserProfile();
      const profileBlock = this.profileBlock(profile);
      if (profileBlock) blocks.push(profileBlock);
    }
    const hits = await this.search(query, { limit: options.limit, namespace: options.namespace ?? 'all' });
    const memoryBlock = this.memoryBlock(hits);
    if (memoryBlock) blocks.push(memoryBlock);
    return blocks;
  }

  async rememberArtifact(input: {
    namespace: MemoryNamespace;
    kind: MemoryKind;
    text: string;
    summary?: string;
    source?: string;
    sessionId?: string;
    workspaceId?: string;
    objective?: string;
    tags?: string[];
    importance?: number;
    relatedIds?: string[];
  }): Promise<SemanticRecord> {
    const now = Date.now();
    const record: SemanticRecord = {
      id: makeId(input.kind),
      namespace: input.namespace,
      kind: input.kind,
      text: normalizeWhitespace(input.text),
      summary: normalizeWhitespace(input.summary ?? shortSummary(input.text)),
      source: normalizeWhitespace(input.source ?? ''),
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      objective: normalizeWhitespace(input.objective ?? ''),
      tags: uniqueItems(input.tags ?? []),
      importance: Math.max(0, Math.min(1, input.importance ?? 0.6)),
      relatedIds: uniqueItems(input.relatedIds ?? []),
      createdAt: now,
      updatedAt: now,
    };
    this.addSemanticRecord(record);
    return record;
  }

  getStateSummary(): {
    engine: 'sqlite' | 'json';
    semanticEngine: 'chroma' | 'local';
    activeWorkspaceId: string | null;
    profileFacts: number;
    semanticRecords: number;
  } {
    return {
      engine: this.engine,
      semanticEngine: this.semanticEngine,
      activeWorkspaceId: this.state.activeWorkspaceId,
      profileFacts: this.state.profile.facts.length,
      semanticRecords: this.semanticJournal.length,
    };
  }
}

export const graceMemory = new GraceMemory();
