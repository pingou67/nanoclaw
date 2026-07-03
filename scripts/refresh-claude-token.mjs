#!/usr/bin/env node
/**
 * Refreshes the Claude OAuth access token using the stored refresh token.
 * Should be run before the access token expires (every ~6h).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

// CLAUDE_CONFIG_DIR moved to ~/.claude-anthropic on this host (2026-07) — probe both.
const CANDIDATE_DIRS = [
  process.env.CLAUDE_CONFIG_DIR,
  path.join(os.homedir(), '.claude-anthropic'),
  path.join(os.homedir(), '.claude'),
].filter(Boolean);
const CREDENTIALS_PATH = CANDIDATE_DIRS
  .map((dir) => path.join(dir, '.credentials.json'))
  .find((p) => fs.existsSync(p))
  ?? path.join(CANDIDATE_DIRS[CANDIDATE_DIRS.length - 1], '.credentials.json');
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

async function refreshToken() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error('No credentials file found at', CREDENTIALS_PATH);
    process.exit(1);
  }

  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const oauth = creds.claudeAiOauth;

  if (!oauth?.refreshToken) {
    console.error('No refresh token found in credentials');
    process.exit(1);
  }

  // Check if token expires within the next 2 hours
  const expiresAt = oauth.expiresAt;
  const twoHoursMs = 2 * 60 * 60 * 1000;
  if (expiresAt && expiresAt - Date.now() > twoHoursMs) {
    const remaining = Math.round((expiresAt - Date.now()) / 1000 / 60);
    console.log(`Token still valid for ${remaining} minutes, skipping refresh`);
    process.exit(0);
  }

  console.log('Refreshing Claude OAuth token...');

  const body = {
    grant_type: 'refresh_token',
    refresh_token: oauth.refreshToken,
    client_id: CLIENT_ID,
    scope: (oauth.scopes || []).join(' '),
  };

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Token refresh failed (${res.status}): ${text}`);
    process.exit(1);
  }

  const data = await res.json();

  creds.claudeAiOauth = {
    ...oauth,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || oauth.refreshToken,
    expiresAt: Date.now() + (data.expires_in * 1000),
  };

  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
  console.log('Token refreshed successfully, expires in', data.expires_in, 'seconds');
}

refreshToken().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
