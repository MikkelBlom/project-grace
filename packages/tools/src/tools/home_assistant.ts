import { vault } from '@grace/core';
import { registerTool } from '../registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// home_assistant — generic Home Assistant REST client (works with any HA setup).
//
// Reads two vault entries: `ha_url` (the HA base URL, e.g. http://homeassistant.local:8123)
// and `ha_token` (a Long-Lived Access Token, sent as a Bearer token). With those, ha_states
// reads entity states and ha_call invokes any service (light.turn_on, switch.toggle, …).
//
// This is the forward-looking client for Mikkel's Google Nest and anything else he exposes
// through Home Assistant; Hue works today via the dedicated hue_* tools.
// ─────────────────────────────────────────────────────────────────────────────

const SETUP_HINT =
  'Run ha_setup for instructions. In short: Home Assistant → your Profile → Long-Lived Access ' +
  'Tokens → Create Token, then store it with vault_set ha_token <token> and the base URL with ' +
  'vault_set ha_url http://homeassistant.local:8123.';

function getConfig(): { url: string; token: string } | { error: string } {
  const url = vault.get('ha_url');
  const token = vault.get('ha_token');
  if (!url || !token) return { error: 'Home Assistant is not set up yet.' };
  return { url: url.trim().replace(/\/+$/, ''), token: token.trim() };
}

async function haFetch(
  cfg: { url: string; token: string },
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ data: any } | { error: string; status?: number }> {
  try {
    const res = await fetch(`${cfg.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return { error: 'Home Assistant rejected the token (HTTP 401).', status: 401 };
    if (!res.ok) return { error: `Home Assistant HTTP ${res.status}`, status: res.status };
    const text = await res.text();
    return { data: text ? JSON.parse(text) : null };
  } catch (e) {
    return { error: `Could not reach Home Assistant at ${cfg.url}: ${String(e)}` };
  }
}

registerTool({
  name: 'ha_states',
  description:
    'List Home Assistant entities with their current state (e.g. lights, switches, sensors, thermostats). ' +
    'Optionally filter by an entity substring like "light" or "kitchen". Use when Mikkel asks about the ' +
    'state of a smart-home device managed through Home Assistant. Requires ha_setup.',
  params: {
    entity: { type: 'string', description: 'optional substring to filter entity_id / friendly name (e.g. "light", "nest")' },
  },
  async run(args) {
    const cfg = getConfig();
    if ('error' in cfg) return { error: cfg.error, hint: SETUP_HINT };

    const r = await haFetch(cfg, 'GET', '/api/states');
    if ('error' in r) return { error: r.error, hint: r.status === 401 ? SETUP_HINT : undefined };

    const filter = typeof args.entity === 'string' ? args.entity.trim().toLowerCase() : '';
    let list = (Array.isArray(r.data) ? r.data : []).map((s: any) => ({
      entity_id: s?.entity_id,
      state: s?.state,
      friendly_name: s?.attributes?.friendly_name,
    }));
    if (filter) {
      list = list.filter(
        (e: any) =>
          String(e.entity_id ?? '').toLowerCase().includes(filter) ||
          String(e.friendly_name ?? '').toLowerCase().includes(filter),
      );
    }
    const total = list.length;
    return { total, shown: Math.min(total, 40), entities: list.slice(0, 40) };
  },
});

registerTool({
  name: 'ha_call',
  description:
    'Call a Home Assistant service to control a device, e.g. domain "light" service "turn_on" on ' +
    'entity "light.kitchen"; or "switch"/"toggle", "climate"/"set_temperature". Use when Mikkel asks to ' +
    'turn something on/off or change a device managed through Home Assistant. Requires ha_setup.',
  params: {
    domain: { type: 'string', description: 'service domain, e.g. light, switch, climate, media_player', required: true },
    service: { type: 'string', description: 'service name, e.g. turn_on, turn_off, toggle', required: true },
    entity_id: { type: 'string', description: 'target entity id, e.g. light.kitchen (optional for some services)' },
    data: { type: 'object', description: 'optional extra service data as JSON, e.g. {"brightness_pct":40} (object or JSON string)' },
  },
  async run(args) {
    const cfg = getConfig();
    if ('error' in cfg) return { error: cfg.error, hint: SETUP_HINT };

    const domain = String(args.domain ?? '').trim();
    const service = String(args.service ?? '').trim();
    if (!domain || !service) return { error: 'domain and service are required (e.g. light / turn_on).' };

    const body: Record<string, unknown> = {};
    if (typeof args.entity_id === 'string' && args.entity_id.trim()) body.entity_id = args.entity_id.trim();

    if (args.data != null && args.data !== '') {
      let extra: any = args.data;
      if (typeof extra === 'string') {
        try { extra = JSON.parse(extra); } catch { return { error: 'data must be valid JSON (an object).' }; }
      }
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(body, extra);
      else return { error: 'data must be a JSON object, e.g. {"brightness_pct":40}.' };
    }

    const r = await haFetch(cfg, 'POST', `/api/services/${domain}/${service}`, body);
    if ('error' in r) return { error: r.error, hint: r.status === 401 ? SETUP_HINT : undefined };

    // HA returns the list of states it changed. Keep the result compact.
    const changed = Array.isArray(r.data)
      ? r.data.map((s: any) => ({ entity_id: s?.entity_id, state: s?.state })).slice(0, 20)
      : r.data;
    return { ok: true, service: `${domain}.${service}`, sent: body, changed };
  },
});

registerTool({
  name: 'ha_setup',
  description:
    'Set up or verify the Home Assistant connection. If a URL and token are already stored, it checks ' +
    'the connection and reports whether Grace is connected; otherwise it returns step-by-step setup ' +
    'instructions. Use when Mikkel wants to connect Home Assistant or asks if it is connected.',
  params: {},
  async run() {
    const cfg = getConfig();
    if ('error' in cfg) {
      return {
        connected: false,
        instructions: [
          'In Home Assistant, click your user name (bottom-left) to open your Profile.',
          'Scroll to "Long-Lived Access Tokens" and click "Create Token"; copy the token (shown once).',
          'Tell Grace: vault_set ha_token <the token>',
          'Tell Grace the base URL: vault_set ha_url http://homeassistant.local:8123 (or your HA IP:port).',
          'Then call ha_setup again to verify the connection.',
        ],
      };
    }

    const r = await haFetch(cfg, 'GET', '/api/');
    if ('error' in r) {
      return {
        connected: false,
        error: r.error,
        hint:
          r.status === 401
            ? 'The token was rejected. Create a fresh Long-Lived Access Token and store it with vault_set ha_token <token>.'
            : 'Check that ha_url is correct and Home Assistant is reachable from this machine.',
      };
    }
    return { connected: true, url: cfg.url, message: r.data?.message ?? 'Home Assistant API reachable.' };
  },
});
