#!/usr/bin/env node
/**
 * Headless Google OAuth re-auth for nanoclaw groups.
 *
 * Bypasses the autoauth MCPs' "open browser on localhost" flow (which
 * doesn't work over SSH / headless). Prints the OAuth URL, waits for the
 * user to paste back the redirect URL (or just the `code=…` value), then
 * exchanges the code for tokens and writes them to the right file.
 *
 * Usage:
 *   node scripts/reauth-google-headless.mjs \
 *     --service gmail|gcal|both \
 *     --keys <path-to-gcp-oauth.keys.json> \
 *     --gmail-token <path-to-gmail-token.json> \
 *     --gcal-token <path-to-google-calendar-token.json> \
 *     [--redirect-port 3000]
 *
 * The OAuth flow:
 *   1. Script prints auth URL → user opens in their LOCAL browser
 *   2. User authorizes with Google
 *   3. Google redirects to http://localhost:<port>/oauth2callback?code=…
 *   4. Browser shows "connection refused" (no server on local:3000)
 *   5. User copies the full URL from the address bar
 *   6. User pastes it into the script (just the code= value works too)
 *   7. Script exchanges the code → writes tokens to the right file(s)
 */
import fs from 'node:fs';
import https from 'node:https';
import readline from 'node:readline';
import { URL } from 'node:url';

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const service = getArg('service') ?? 'both';
const keysPath = getArg('keys');
const gmailTokenPath = getArg('gmail-token');
const gcalTokenPath = getArg('gcal-token');
const redirectPort = getArg('redirect-port') ?? '3000';

if (!keysPath) {
  console.error('ERROR: --keys <path> is required');
  process.exit(1);
}
if (service === 'gmail' && !gmailTokenPath) {
  console.error('ERROR: --gmail-token <path> required for service=gmail');
  process.exit(1);
}
if (service === 'gcal' && !gcalTokenPath) {
  console.error('ERROR: --gcal-token <path> required for service=gcal');
  process.exit(1);
}
if (service === 'both' && (!gmailTokenPath || !gcalTokenPath)) {
  console.error('ERROR: both --gmail-token and --gcal-token required for service=both');
  process.exit(1);
}

const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
// Use the EXACT redirect URI registered in the OAuth client. Google's
// `redirect_uri` param must match one of the registered URIs byte-for-byte
// or the auth request is rejected. The autoauth MCPs use the same
// `keys.installed.redirect_uris[0]` source so we match their behavior.
const redirectUri =
  keys.installed?.redirect_uris?.[0] ?? `http://localhost:${redirectPort}/oauth2callback`;

// Scopes match the autoauth MCPs exactly so the token format is identical
// to what the MCP would have produced itself.
const SCOPES = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.settings.basic',
  ],
  gcal: ['https://www.googleapis.com/auth/calendar'],
};

function buildAuthUrl(scope) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', keys.client_id ?? keys.installed?.client_id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scope.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  return u.toString();
}

function exchangeCode(code, scope) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: keys.client_id ?? keys.installed?.client_id,
      client_secret: keys.client_secret ?? keys.installed?.client_secret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      scope: scope.join(' '),
    });
    const req = https.request(
      {
        method: 'POST',
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body.toString()),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Token exchange failed (${res.statusCode}): ${chunks}`));
          }
          try {
            resolve(JSON.parse(chunks));
          } catch (e) {
            reject(new Error(`Bad token response: ${chunks}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body.toString());
    req.end();
  });
}

const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
const ask = (q) => new Promise((res) => rl.question(q, res));

async function reauthOne(label, scope, tokenPath, wrapKey = null) {
  const authUrl = buildAuthUrl(scope);
  console.error(`\n=== ${label} re-auth ===`);
  console.error(`\n1. Open this URL in your LOCAL browser:\n\n   ${authUrl}\n`);
  console.error(`2. Sign in to Google and authorize.`);
  console.error(`3. Google will redirect to ${redirectUri}?code=…`);
  console.error(`   → browser will show "connection refused" (expected, no server on localhost)`);
  console.error(`4. Copy the FULL URL from the address bar (or just the code=… value)`);
  console.error(`5. Paste it below:\n`);

  const pasted = (await ask(`   ${label} code/URL: `)).trim();
  let code = pasted;
  try {
    const u = new URL(pasted);
    code = u.searchParams.get('code') ?? pasted;
  } catch {
    // Not a URL — treat as raw code
  }
  if (!code) {
    console.error(`   ERROR: no code found in: ${pasted}`);
    process.exit(1);
  }

  console.error(`   Exchanging code for tokens…`);
  const tokens = await exchangeCode(code, scope);

  // Token file format differs per MCP server:
  //  - gmail (gongrzhe): raw OAuth response written as-is (uses expires_in).
  //  - gcal  (@cocal):   multi-account store keyed by account name ("normal"),
  //                      and google-auth-library expects an absolute `expiry_date`
  //                      (ms epoch) rather than the relative `expires_in`.
  let out;
  if (wrapKey) {
    const account = { ...tokens };
    if (typeof tokens.expires_in === 'number') {
      account.expiry_date = Date.now() + tokens.expires_in * 1000;
    }
    out = { [wrapKey]: account };
  } else {
    out = tokens;
  }
  fs.writeFileSync(tokenPath, JSON.stringify(out, null, 2));
  console.error(`   ✓ written to ${tokenPath}${wrapKey ? ` (wrapped under "${wrapKey}", expiry_date set)` : ''}`);
  console.error(`     access_token expires: ${new Date(Date.now() + (tokens.expires_in ?? 0) * 1000).toISOString()}`);
  if (tokens.refresh_token) {
    console.error(`     refresh_token: present (good — long-lived)`);
  } else {
    console.error(`     refresh_token: MISSING — re-auth needed again on next token expiry.`);
    console.error(`     (often means Google already has a token for this app; revoke at https://myaccount.google.com/permissions and retry)`);
  }
}

async function main() {
  if (service === 'gmail' || service === 'both') {
    await reauthOne('Gmail', SCOPES.gmail, gmailTokenPath);
  }
  if (service === 'gcal' || service === 'both') {
    // @cocal/google-calendar-mcp keys tokens by account name; "normal" is the default.
    await reauthOne('Google Calendar', SCOPES.gcal, gcalTokenPath, 'normal');
  }
  console.error(`\n=== DONE ===`);
  rl.close();
}

main().catch((e) => {
  console.error(`\nFATAL: ${e.message ?? e}`);
  rl.close();
  process.exit(1);
});
