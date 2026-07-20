// ─────────────────────────────────────────────────────────────────────────────
// Shared Google auth for Grace's Calendar + Gmail tools.
//
// Installed-app OAuth, refresh-token flow — NO google library. Mikkel does a
// one-time device-flow sign-in via `node scripts/google-auth.mjs`, which stores
// google_client_id / google_client_secret / google_refresh_token in the encrypted
// vault. This module exchanges that refresh_token for a short-lived access token
// and caches it in-process until just before it expires.
//
// The tools call googleFetch()/googleToken(); on any auth problem we throw a
// GoogleAuthError carrying a `setup` hint that points back at the auth script, so
// the assistant can tell Mikkel exactly how to fix it instead of failing opaquely.
// ─────────────────────────────────────────────────────────────────────────────

import { vault } from '@grace/core';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Shown to Mikkel whenever Google isn't set up yet. */
export const GOOGLE_SETUP_HINT =
  'Run  node scripts/google-auth.mjs  from the grace/ root to sign in to Google (one-time, Calendar + Gmail).';

/** Auth/setup failures carry a setup hint so tools can surface it to Mikkel. */
export class GoogleAuthError extends Error {
  readonly setup = GOOGLE_SETUP_HINT;
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

/** Normalize any thrown value into the tool result shape `{ error, setup? }`. */
export function googleErrorResult(e: unknown): { error: string; setup?: string } {
  if (e instanceof GoogleAuthError) return { error: e.message, setup: e.setup };
  const msg = e instanceof Error ? e.message : String(e);
  return { error: msg };
}

let cachedToken: string | null = null;
let cachedExpiry = 0; // epoch ms; we refresh a minute early
let refreshInFlight: Promise<string> | null = null;

/** Exchange the vault refresh_token for a fresh access token and cache it. */
async function doRefresh(): Promise<string> {
  const clientId = vault.get('google_client_id');
  const clientSecret = vault.get('google_client_secret');
  const refreshToken = vault.get('google_refresh_token');

  if (!clientId || !clientSecret) {
    throw new GoogleAuthError(`Google client id/secret are not in the vault. ${GOOGLE_SETUP_HINT}`);
  }
  if (!refreshToken) {
    throw new GoogleAuthError(`Grace is not signed in to Google yet (no refresh token). ${GOOGLE_SETUP_HINT}`);
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new GoogleAuthError(`Could not reach Google to refresh the token: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    // A revoked or expired refresh token needs a fresh sign-in.
    throw new GoogleAuthError(`Google token refresh failed (HTTP ${res.status}). ${text} ${GOOGLE_SETUP_HINT}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new GoogleAuthError(`Google token refresh returned no access_token. ${GOOGLE_SETUP_HINT}`);
  }

  cachedToken = data.access_token;
  cachedExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
  return cachedToken;
}

/**
 * Return a fresh Google access token, exchanging the vault's refresh_token when the cached one is
 * missing or about to expire (or when `force` is set, e.g. after a 401). Concurrent callers share a
 * single in-flight refresh so a batched Calendar+Gmail turn fires ONE refresh, not two.
 */
export async function googleToken(force = false): Promise<string> {
  if (!force && cachedToken && Date.now() < cachedExpiry - 60_000) return cachedToken;
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

/**
 * fetch() against a Google REST API with the Bearer token attached and a default timeout. On a 401
 * (token invalidated server-side before its local expiry), the cache is force-refreshed and the
 * request retried ONCE, so a stale cached token doesn't wedge every call for up to an hour.
 */
export async function googleFetch(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const attempt = (token: string) => fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
  let res = await attempt(await googleToken());
  if (res.status === 401) {
    cachedToken = null; cachedExpiry = 0;
    res = await attempt(await googleToken(true));
  }
  return res;
}
