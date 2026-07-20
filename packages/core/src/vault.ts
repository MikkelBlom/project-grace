// ─────────────────────────────────────────────────────────────────────────────
// Secrets vault — encrypted-at-rest store for API keys / tokens (calendar, Gmail, HA, VLC…).
//
// AES-256-GCM, key derived (scrypt) from GRACE_VAULT_KEY. If that env isn't set, a machine+user
// seed is used so secrets are still not plaintext on disk — but set GRACE_VAULT_KEY for real
// security (a machine seed is guessable). Integrations read via vault.get(key); Mikkel stores keys
// with the vault_set tool (he enters them; Grace/Claude never does).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = process.env.GRACE_REPO_ROOT
  ? path.resolve(process.env.GRACE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const VAULT_PATH = path.join(ROOT, 'data', 'vault.enc');

// File layout: [ salt(16) | iv(12) | tag(16) | ciphertext ]. The salt is random PER VAULT (stored
// in the file), so two installs with the same default key don't share a derivation — a global
// constant salt made the default-key vault offline-brute-forceable.
const SALT_LEN = 16, IV_LEN = 12, TAG_LEN = 16;

const keyCache = new Map<string, Buffer>();
function masterKey(salt: Buffer): Buffer {
  const secret = process.env.GRACE_VAULT_KEY || `${os.hostname()}::${os.userInfo().username}::grace-vault-default`;
  const id = salt.toString('hex') + (process.env.GRACE_VAULT_KEY ? ':k' : ':d');
  let k = keyCache.get(id);
  if (!k) { k = crypto.scryptSync(secret, salt, 32); keyCache.set(id, k); }
  return k;
}

type VaultData = Record<string, string>;

class Vault {
  /** Load & decrypt. Returns {} if the vault file doesn't exist yet, but THROWS if the file is
   *  present and can't be decrypted/parsed (wrong GRACE_VAULT_KEY or corruption). This is what stops
   *  set()/delete() from silently overwriting good ciphertext with a fresh single-key vault. */
  private load(): VaultData {
    let raw: Buffer;
    try { raw = fs.readFileSync(VAULT_PATH); }
    catch (e: any) { if (e?.code === 'ENOENT') return {}; throw e; }
    try {
      const salt = raw.subarray(0, SALT_LEN);
      const iv = raw.subarray(SALT_LEN, SALT_LEN + IV_LEN);
      const tag = raw.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
      const enc = raw.subarray(SALT_LEN + IV_LEN + TAG_LEN);
      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(salt), iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
      return JSON.parse(dec.toString('utf8'));
    } catch {
      throw new Error('Vault present but could not be decrypted (wrong GRACE_VAULT_KEY or corrupted file). Refusing to overwrite it — restore the key, or move data/vault.enc aside to start fresh.');
    }
  }

  private save(data: VaultData): void {
    const salt = crypto.randomBytes(SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(salt), iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    fs.mkdirSync(path.dirname(VAULT_PATH), { recursive: true });
    fs.writeFileSync(VAULT_PATH, Buffer.concat([salt, iv, tag, enc]));
  }

  /** Read a secret. A stored value wins; `GRACE_<KEY>` env is only a FALLBACK when nothing is
   *  stored, so a stale/unrelated env var can't silently shadow a real stored secret. Decryption
   *  failure yields undefined here (reads must not crash an integration). */
  get(key: string): string | undefined {
    let stored: string | undefined;
    try { stored = this.load()[key]; } catch { stored = undefined; }
    if (stored != null) return stored;
    const env = process.env[`GRACE_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
    return env ? env : undefined;
  }

  set(key: string, value: string): void { const d = this.load(); d[key] = value; this.save(d); }
  delete(key: string): boolean { const d = this.load(); if (!(key in d)) return false; delete d[key]; this.save(d); return true; }
  keys(): string[] { return Object.keys(this.load()); }
  usingDefaultKey(): boolean { return !process.env.GRACE_VAULT_KEY; }
}

export const vault = new Vault();
