import { vault } from '@grace/core';
import { registerTool } from '../registry.js';

// Manage the encrypted secrets vault (API keys / tokens for integrations). Mikkel enters values.
registerTool({
  name: 'vault_set',
  description: 'Store a secret (API key / token / password) in Grace\'s encrypted vault, under a key name. Use when Mikkel gives Grace a credential to remember for an integration (e.g. hue_key, ha_token, vlc_password). The value is encrypted at rest.',
  params: {
    key: { type: 'string', description: 'the name to store it under (e.g. hue_key)', required: true },
    value: { type: 'string', description: 'the secret value', required: true },
  },
  async run(args) {
    const key = String(args.key ?? '').trim();
    const value = String(args.value ?? '');
    if (!key || !value) return { error: 'key and value are required' };
    vault.set(key, value);
    return {
      ok: true,
      key,
      note: vault.usingDefaultKey()
        ? 'Stored. NOTE: set GRACE_VAULT_KEY in start-grace.ps1 for strong encryption (currently a machine-derived key).'
        : 'Stored (encrypted).',
    };
  },
});

registerTool({
  name: 'vault_list',
  description: 'List the NAMES of secrets stored in the vault (never the values). Use to see what credentials Grace has.',
  params: {},
  async run() { return { keys: vault.keys() }; },
});

registerTool({
  name: 'vault_delete',
  description: 'Delete a secret from the vault by its key name.',
  params: { key: { type: 'string', description: 'the key name to delete', required: true } },
  async run(args) {
    const removed = vault.delete(String(args.key ?? '').trim());
    return { ok: true, removed };
  },
});
