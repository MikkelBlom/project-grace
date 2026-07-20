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

function masterKey(): Buffer {
  const secret = process.env.GRACE_VAULT_KEY || `${os.hostname()}::${os.userInfo().username}::grace-vault-default`;
  return crypto.scryptSync(secret, 'grace-vault-salt-v1', 32);
}

type VaultData = Record<string, string>;

class Vault {
  private load(): VaultData {
    try {
      const raw = fs.readFileSync(VAULT_PATH);
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const enc = raw.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
      return JSON.parse(dec.toString('utf8'));
    } catch { return {}; }
  }

  private save(data: VaultData): void {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    fs.mkdirSync(path.dirname(VAULT_PATH), { recursive: true });
    fs.writeFileSync(VAULT_PATH, Buffer.concat([iv, tag, enc]));
  }

  /** Read a secret. Also checks env `GRACE_<KEY>` (uppercased) as a fallback so keys can come from
   *  the environment without being stored on disk. */
  get(key: string): string | undefined {
    const env = process.env[`GRACE_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
    if (env) return env;
    return this.load()[key];
  }

  set(key: string, value: string): void { const d = this.load(); d[key] = value; this.save(d); }
  delete(key: string): boolean { const d = this.load(); if (!(key in d)) return false; delete d[key]; this.save(d); return true; }
  keys(): string[] { return Object.keys(this.load()); }
  usingDefaultKey(): boolean { return !process.env.GRACE_VAULT_KEY; }
}

export const vault = new Vault();
