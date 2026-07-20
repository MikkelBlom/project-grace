import { registerTool } from '../registry.js';

// music_control — drive a LOCAL VLC instance through its HTTP interface. Fully offline.
// VLC exposes /requests/status.json?command=... guarded by HTTP Basic auth with an EMPTY
// username and the password configured in VLC. Enable it once:
//   VLC → Preferences → Show settings: All → Interface → Main interfaces → check "Web",
//   then Main interfaces → Lua → set a password, and restart VLC.

const VLC_URL = (process.env.GRACE_VLC_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const VLC_PASSWORD = process.env.GRACE_VLC_PASSWORD ?? '';

const ENABLE_HINT =
  'Could not reach VLC\'s web interface at ' + VLC_URL + '. To enable it: open VLC → Preferences → ' +
  '(bottom-left) Show settings: All → Interface → Main interfaces → tick "Web"; then under Main interfaces → Lua, ' +
  'set a password; restart VLC. Then set GRACE_VLC_PASSWORD (and GRACE_VLC_URL if not http://localhost:8080).';

const ACTION_COMMANDS: Record<string, string> = {
  play: 'pl_play',
  pause: 'pl_pause',
  next: 'pl_next',
  prev: 'pl_previous',
  stop: 'pl_stop',
};

function authHeader(): string {
  // Basic auth, empty username. Buffer is available in the Node runtime.
  return 'Basic ' + Buffer.from(`:${VLC_PASSWORD}`).toString('base64');
}

function summarizeStatus(json: any) {
  if (!json || typeof json !== 'object') return {};
  const meta = json?.information?.category?.meta ?? {};
  const nowPlaying = meta.title || meta.filename || undefined;
  const volumePct = typeof json.volume === 'number' ? Math.round((json.volume / 256) * 100) : undefined;
  return {
    state: json.state,               // 'playing' | 'paused' | 'stopped'
    volumePct,
    nowPlaying,
    artist: meta.artist || undefined,
    timeSec: typeof json.time === 'number' ? json.time : undefined,
    lengthSec: typeof json.length === 'number' ? json.length : undefined,
    position: typeof json.position === 'number' ? json.position : undefined,
  };
}

async function vlcRequest(params: Record<string, string>): Promise<{ json: any } | { error: string; hint?: string }> {
  const qs = new URLSearchParams(params).toString();
  const url = `${VLC_URL}/requests/status.json${qs ? `?${qs}` : ''}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: authHeader() },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 401) return { error: 'VLC rejected the password (HTTP 401).', hint: ENABLE_HINT };
    if (!res.ok) return { error: `VLC HTTP ${res.status}`, hint: ENABLE_HINT };
    return { json: await res.json() };
  } catch (e) {
    return { error: `VLC not reachable: ${String(e)}`, hint: ENABLE_HINT };
  }
}

registerTool({
  name: 'music_control',
  description: 'Control local music playback in VLC (play, pause, next track, previous, stop, status, set volume, or play a file). Requires VLC\'s web interface to be enabled. Use when Mikkel asks to play, pause, skip, or adjust his music.',
  params: {
    action: { type: 'string', description: "one of: play, pause, next, prev, stop, status, volume", required: true },
    value: { type: 'number', description: 'volume level 0-100 (only for action=volume)' },
    file: { type: 'string', description: 'optional path to a media file to enqueue and play immediately' },
  },
  async run(args) {
    const action = String(args.action ?? '').trim().toLowerCase();
    const file = typeof args.file === 'string' ? args.file.trim() : '';

    // A file path takes priority: enqueue + play it regardless of action.
    if (file) {
      const r = await vlcRequest({ command: 'in_play', input: file });
      if ('error' in r) return r;
      return { action: 'play', file, status: summarizeStatus(r.json) };
    }

    if (action === 'volume') {
      const raw = Number(args.value);
      if (!Number.isFinite(raw)) return { error: 'volume action needs a numeric "value" between 0 and 100' };
      const pct = Math.max(0, Math.min(100, raw));
      const val = Math.round((pct / 100) * 256); // VLC: 256 == 100%
      const r = await vlcRequest({ command: 'volume', val: String(val) });
      if ('error' in r) return r;
      return { action: 'volume', requestedPct: pct, status: summarizeStatus(r.json) };
    }

    if (action === 'status') {
      const r = await vlcRequest({});
      if ('error' in r) return r;
      return { action: 'status', status: summarizeStatus(r.json) };
    }

    const command = ACTION_COMMANDS[action];
    if (!command) {
      return { error: `unknown action "${action}". Use one of: play, pause, next, prev, stop, status, volume (or pass a file).` };
    }
    const r = await vlcRequest({ command });
    if ('error' in r) return r;
    return { action, status: summarizeStatus(r.json) };
  },
});
