#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// google-auth.mjs — one-time Google sign-in for Grace (Calendar + Gmail).
//
// Runs the OAuth 2.0 *device* flow (a.k.a. "TV and Limited Input") — no browser
// redirect, no local server, no google library. It:
//   1. reads google_client_id / google_client_secret from the vault
//      (prompts you to enter + store them if they're missing),
//   2. requests a device + user code from Google,
//   3. shows you a URL + code to approve in any browser,
//   4. polls until you approve, then stores the resulting refresh_token in the
//      vault as google_refresh_token.
//
// The Calendar/Gmail tools then exchange that refresh_token for access tokens on
// demand (see packages/tools/src/lib/google.ts).
//
// SCOPES: calendar (read/write) + gmail.modify (read + create drafts, NOT send).
// Grace never sends email — gmail.modify is used only to read mail and save drafts.
//
// ── ONE-TIME GOOGLE CLOUD SETUP (do this first) ──────────────────────────────
//   1. https://console.cloud.google.com  → create/select a project.
//   2. APIs & Services → Enable APIs → enable "Google Calendar API" AND "Gmail API".
//   3. APIs & Services → OAuth consent screen → configure (External is fine);
//      add yourself as a Test user; add the two scopes above.
//   4. APIs & Services → Credentials → Create Credentials → OAuth client ID →
//      Application type: "TV and Limited Input devices".
//   5. Copy the Client ID + Client secret — this script will ask for them (or
//      set them ahead of time with Grace's vault_set tool: google_client_id /
//      google_client_secret).
//
// Run from the grace/ root:   node scripts/google-auth.mjs
//
// NOTE: the vault is encrypted with GRACE_VAULT_KEY (or a machine-derived key if
// unset). Run this with the SAME GRACE_VAULT_KEY the assistant runs with, or the
// stored token won't decrypt at runtime.
// ─────────────────────────────────────────────────────────────────────────────

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { vault } from '../packages/core/dist/index.js';

const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
].join(' ');

const rl = readline.createInterface({ input, output });
const die = (msg) => { console.error(`\n✗ ${msg}`); rl.close(); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureCreds() {
  let clientId = vault.get('google_client_id');
  let clientSecret = vault.get('google_client_secret');

  if (!clientId) {
    console.log('\nNo google_client_id in the vault.');
    clientId = (await rl.question('Paste your Google OAuth Client ID: ')).trim();
    if (!clientId) die('A client ID is required.');
    vault.set('google_client_id', clientId);
    console.log('  stored google_client_id ✓');
  }
  if (!clientSecret) {
    console.log('\nNo google_client_secret in the vault.');
    clientSecret = (await rl.question('Paste your Google OAuth Client secret: ')).trim();
    if (!clientSecret) die('A client secret is required.');
    vault.set('google_client_secret', clientSecret);
    console.log('  stored google_client_secret ✓');
  }
  return { clientId, clientSecret };
}

async function requestDeviceCode(clientId) {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPES }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    die(`Device-code request failed (HTTP ${res.status}): ${data.error ?? ''} ${data.error_description ?? ''}\n` +
        `Check that the OAuth client is type "TV and Limited Input devices" and both APIs are enabled.`);
  }
  return data; // { device_code, user_code, verification_url, expires_in, interval }
}

async function poll({ clientId, clientSecret, deviceCode, interval, expiresIn }) {
  const deadline = Date.now() + expiresIn * 1000;
  let waitMs = Math.max(1, interval || 5) * 1000;

  while (Date.now() < deadline) {
    await sleep(waitMs);
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.refresh_token) return data;
    if (res.ok && data.access_token && !data.refresh_token) {
      die('Google returned an access token but no refresh token. This account may already be authorized — ' +
          'revoke Grace at https://myaccount.google.com/permissions and run this again.');
    }

    switch (data.error) {
      case 'authorization_pending':
        process.stdout.write('.');
        break;
      case 'slow_down':
        waitMs += 5000;
        break;
      case 'access_denied':
        die('You denied the request. Nothing was stored.');
        break;
      case 'expired_token':
        die('The code expired before you approved it. Run the script again.');
        break;
      default:
        die(`Token polling failed: ${data.error ?? `HTTP ${res.status}`} ${data.error_description ?? ''}`);
    }
  }
  die('Timed out waiting for approval. Run the script again.');
}

async function main() {
  console.log('— Grace · Google sign-in (Calendar + Gmail) —');
  console.log('Scopes: calendar (read/write) + gmail.modify (read + drafts, NEVER send).\n');

  const { clientId, clientSecret } = await ensureCreds();

  console.log('\nRequesting a device code from Google…');
  const dc = await requestDeviceCode(clientId);

  console.log('\n────────────────────────────────────────────────');
  console.log(`  1. On any device, open:  ${dc.verification_url}`);
  console.log(`  2. Enter this code:      ${dc.user_code}`);
  console.log(`  3. Approve access for Calendar + Gmail.`);
  console.log('────────────────────────────────────────────────');
  console.log('\nWaiting for approval (this window will update)…');

  const tokens = await poll({
    clientId,
    clientSecret,
    deviceCode: dc.device_code,
    interval: dc.interval,
    expiresIn: dc.expires_in,
  });

  vault.set('google_refresh_token', tokens.refresh_token);
  console.log('\n\n✓ Authorized. Stored google_refresh_token in the vault.');
  console.log('  Grace can now read your Calendar/Gmail and create drafts.');
  console.log('  Reminder: Grace never SENDS email — you send drafts yourself.\n');
  rl.close();
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
