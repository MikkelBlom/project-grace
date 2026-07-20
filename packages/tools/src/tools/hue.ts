import { vault } from '@grace/core';
import { registerTool } from '../registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// hue — Philips Hue LOCAL bridge control (Hue API v1, no cloud).
//
// Talks straight to the bridge on the LAN over plain HTTP (http://<ip>/api/...).
// Credentials live in the vault: `hue_bridge_ip` (the bridge LAN IP) and `hue_key`
// (the app/username the bridge hands out after you press its link button).
//
// First-time setup: call hue_setup. It discovers the bridge and asks the bridge
// for a key — which only works AFTER the round button on the bridge is physically
// pressed. Once we have both, hue_lights lists everything and hue_set controls it.
// ─────────────────────────────────────────────────────────────────────────────

const DISCOVERY_URL = 'https://discovery.meethue.com/';
const DEVICE_TYPE = 'grace#local';
const SETUP_HINT =
  'Run hue_setup first: it discovers your Hue bridge and creates a key. Note that the ' +
  'bridge only hands out a key AFTER you press the round link button on top of it.';

// Simple color name → Hue hue/sat mapping. Hue: hue 0-65535, sat 0-254.
// white/warm use low saturation (+ warm color-temperature) instead of a hue.
const COLORS: Record<string, { hue?: number; sat?: number; ct?: number }> = {
  red: { hue: 0, sat: 254 },
  orange: { hue: 5000, sat: 254 },
  yellow: { hue: 10000, sat: 254 },
  green: { hue: 25500, sat: 254 },
  blue: { hue: 46920, sat: 254 },
  purple: { hue: 50000, sat: 254 },
  pink: { hue: 56100, sat: 200 },
  white: { sat: 0 },
  warm: { sat: 0, ct: 454 },
};

function getIp(): string | undefined {
  const ip = vault.get('hue_bridge_ip');
  return ip ? ip.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') : undefined;
}

/** Low-level bridge request over plain HTTP. Returns parsed JSON or an error object. */
async function bridge(
  method: 'GET' | 'POST' | 'PUT',
  ip: string,
  path: string,
  body?: unknown,
): Promise<{ data: any } | { error: string }> {
  const url = `http://${ip}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { error: `Hue bridge HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: `Could not reach the Hue bridge at ${ip}: ${String(e)}` };
  }
}

/** Pull the first {error:{...}} out of a Hue v1 response array, if any. */
function firstError(data: any): { type: number; description: string } | undefined {
  if (Array.isArray(data)) {
    for (const item of data) if (item && item.error) return item.error;
  }
  return undefined;
}

registerTool({
  name: 'hue_setup',
  description:
    'Set up Philips Hue: discover the local bridge and create an API key. IMPORTANT: press the ' +
    'round link button on top of the Hue bridge FIRST, then call this. Use when Mikkel is connecting ' +
    'his Hue lights for the first time (or after "press the button" was reported). Optional ip to skip discovery.',
  params: {
    ip: { type: 'string', description: 'bridge LAN IP to use directly (optional; otherwise auto-discovered)' },
  },
  async run(args) {
    // 1) Determine the bridge IP: explicit arg > vault > cloud discovery.
    let ip = typeof args.ip === 'string' && args.ip.trim() ? args.ip.trim() : getIp();
    if (!ip) {
      try {
        const res = await fetch(DISCOVERY_URL, {
          headers: { 'User-Agent': 'GraceAssistant/0.1' },
          signal: AbortSignal.timeout(6000),
        });
        if (res.ok) {
          const list = await res.json();
          if (Array.isArray(list) && list[0]?.internalipaddress) ip = String(list[0].internalipaddress);
        }
      } catch { /* discovery is best-effort; handled below */ }
    }
    if (!ip) {
      return {
        error:
          'No Hue bridge found via discovery. Connect the bridge to your network, or store its LAN IP ' +
          "manually with vault_set hue_bridge_ip <ip>, then call hue_setup again.",
      };
    }
    ip = ip.replace(/^https?:\/\//, '').replace(/\/+$/, '');

    // 2) Ask the bridge for a key. Requires the physical link button to have been pressed.
    const r = await bridge('POST', ip, '/api', { devicetype: DEVICE_TYPE });
    if ('error' in r) return { error: r.error, hint: 'Is the bridge reachable on your LAN at that IP?' };

    const err = firstError(r.data);
    if (err) {
      if (err.type === 101) {
        // Store the IP now so the retry can skip discovery.
        vault.set('hue_bridge_ip', ip);
        return {
          needsButton: true,
          bridge_ip: ip,
          message:
            'Press the round link button on top of your Hue bridge, then call hue_setup again ' +
            'within 30 seconds. (The bridge was found at ' + ip + '.)',
        };
      }
      return { error: `Hue setup failed: ${err.description || 'error type ' + err.type}` };
    }

    const key = Array.isArray(r.data) ? r.data[0]?.success?.username : undefined;
    if (!key) return { error: 'Hue setup did not return a key.', raw: r.data };

    vault.set('hue_bridge_ip', ip);
    vault.set('hue_key', String(key));
    return { ok: true, bridge_ip: ip, message: 'Hue is connected. You can now list and control your lights.' };
  },
});

registerTool({
  name: 'hue_lights',
  description:
    'List Philips Hue lights and rooms/groups with their on/off state and brightness. Use when Mikkel ' +
    'asks what lights he has, which are on, or before controlling them. Requires hue_setup to have run.',
  params: {},
  async run() {
    const ip = getIp();
    const key = vault.get('hue_key');
    if (!ip || !key) return { error: 'Hue is not set up yet.', hint: SETUP_HINT };

    const lr = await bridge('GET', ip, `/api/${key}/lights`);
    if ('error' in lr) return { error: lr.error, hint: SETUP_HINT };
    const lErr = firstError(lr.data);
    if (lErr) return { error: `Hue: ${lErr.description}`, hint: lErr.type === 1 ? SETUP_HINT : undefined };

    const gr = await bridge('GET', ip, `/api/${key}/groups`);
    const groupsData = 'error' in gr ? {} : gr.data;

    const lights = Object.entries(lr.data ?? {}).map(([id, l]: [string, any]) => ({
      id,
      name: l?.name,
      on: !!l?.state?.on,
      brightness: l?.state?.bri != null ? Math.round((l.state.bri / 254) * 100) : undefined,
      reachable: l?.state?.reachable !== false,
    }));

    const groups = Object.entries(groupsData ?? {}).map(([id, g]: [string, any]) => ({
      id,
      name: g?.name,
      type: g?.type,
      anyOn: !!g?.state?.any_on,
      allOn: !!g?.state?.all_on,
      brightness: g?.action?.bri != null ? Math.round((g.action.bri / 254) * 100) : undefined,
      lightCount: Array.isArray(g?.lights) ? g.lights.length : undefined,
    }));

    return { lightCount: lights.length, lights, roomCount: groups.length, rooms: groups };
  },
});

registerTool({
  name: 'hue_set',
  description:
    'Control a Philips Hue light or room BY NAME: turn on/off, set brightness (0-100), or set a color. ' +
    'Use when Mikkel says things like "turn off the kitchen", "dim the living room to 20%", or "make the ' +
    'bedroom blue". Matches the name against both lights and rooms. Requires hue_setup to have run.',
  params: {
    name: { type: 'string', description: 'the light or room name (e.g. "Living room", "Kitchen lamp")', required: true },
    on: { type: 'boolean', description: 'true to turn on, false to turn off' },
    brightness: { type: 'number', description: 'brightness 0-100 (implies on)' },
    color: {
      type: 'string',
      description: 'color name: red, orange, yellow, green, blue, purple, pink, white, warm',
    },
  },
  async run(args) {
    const ip = getIp();
    const key = vault.get('hue_key');
    if (!ip || !key) return { error: 'Hue is not set up yet.', hint: SETUP_HINT };

    const name = String(args.name ?? '').trim();
    if (!name) return { error: 'name is required (a light or room name)' };

    // Build the state body from the requested changes.
    const body: Record<string, unknown> = {};
    if (typeof args.on === 'boolean') body.on = args.on;

    if (args.brightness != null && args.brightness !== '') {
      const pct = Math.max(0, Math.min(100, Number(args.brightness)));
      if (!Number.isFinite(pct)) return { error: 'brightness must be a number 0-100' };
      if (pct === 0) {
        body.on = false;
      } else {
        body.bri = Math.max(1, Math.min(254, Math.round((pct / 100) * 254)));
        if (body.on === undefined) body.on = true;
      }
    }

    if (typeof args.color === 'string' && args.color.trim()) {
      const c = COLORS[args.color.trim().toLowerCase()];
      if (!c) {
        return {
          error: `unknown color "${args.color}". Try: ${Object.keys(COLORS).join(', ')}.`,
        };
      }
      if (c.hue !== undefined) body.hue = c.hue;
      if (c.sat !== undefined) body.sat = c.sat;
      if (c.ct !== undefined) body.ct = c.ct;
      if (body.on === undefined) body.on = true;
    }

    if (Object.keys(body).length === 0) {
      return { error: 'Nothing to do. Pass on, brightness, and/or color.' };
    }

    // Match the name against groups (rooms) first, then individual lights.
    const gr = await bridge('GET', ip, `/api/${key}/groups`);
    const lr = await bridge('GET', ip, `/api/${key}/lights`);
    if ('error' in lr) return { error: lr.error, hint: SETUP_HINT };
    const lErr = firstError(lr.data);
    if (lErr) return { error: `Hue: ${lErr.description}`, hint: lErr.type === 1 ? SETUP_HINT : undefined };

    const lower = name.toLowerCase();
    const match = (entries: Record<string, any> | undefined) => {
      const list = Object.entries(entries ?? {});
      const exact = list.find(([, v]) => String(v?.name ?? '').toLowerCase() === lower);
      if (exact) return exact;
      return list.find(([, v]) => String(v?.name ?? '').toLowerCase().includes(lower));
    };

    const groupHit = 'error' in gr ? undefined : match(gr.data);
    if (groupHit) {
      const [id, g] = groupHit;
      const r = await bridge('PUT', ip, `/api/${key}/groups/${id}/action`, body);
      if ('error' in r) return { error: r.error };
      const err = firstError(r.data);
      if (err) return { error: `Hue: ${err.description}`, target: 'room', name: g?.name };
      return { ok: true, target: 'room', id, name: g?.name, applied: body };
    }

    const lightHit = match(lr.data);
    if (lightHit) {
      const [id, l] = lightHit;
      const r = await bridge('PUT', ip, `/api/${key}/lights/${id}/state`, body);
      if ('error' in r) return { error: r.error };
      const err = firstError(r.data);
      if (err) return { error: `Hue: ${err.description}`, target: 'light', name: l?.name };
      return { ok: true, target: 'light', id, name: l?.name, applied: body };
    }

    return { error: `No Hue light or room matches "${name}". Call hue_lights to see the available names.` };
  },
});
