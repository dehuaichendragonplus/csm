'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { google } = require('googleapis');

const DRIVE_FULL_SCOPE = 'https://www.googleapis.com/auth/drive';
// drive 全量权限用于「上传覆盖远端表」；metadata.readonly 仅能读取修改时间
const SCOPES = ['https://www.googleapis.com/auth/drive.metadata.readonly', DRIVE_FULL_SCOPE];

function hasUploadScope(token) {
  if (!token || typeof token.scope !== 'string') return false;
  return token.scope.split(/\s+/).includes(DRIVE_FULL_SCOPE);
}

function loadCredentials(credentialsPath) {
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`OAuth credentials not found at ${credentialsPath}. Copy credentials.json.example and fill in client_id/client_secret from the team wiki.`);
  }
  const raw = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  const cfg = raw.installed || raw.web;
  if (!cfg || !cfg.client_id || !cfg.client_secret) {
    throw new Error('credentials.json missing client_id or client_secret');
  }
  return cfg;
}

function createOAuthClient(credentials, redirectUri) {
  return new google.auth.OAuth2(credentials.client_id, credentials.client_secret, redirectUri);
}

function loadToken(tokenPath) {
  if (!fs.existsSync(tokenPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function saveToken(tokenPath, token) {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2) + '\n', 'utf8');
}

function clearToken(tokenPath) {
  if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
}

function getAuthUrl(oauth2Client) {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
}

async function exchangeCodeForToken(oauth2Client, code) {
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

module.exports = {
  SCOPES,
  hasUploadScope,
  loadCredentials,
  createOAuthClient,
  loadToken,
  saveToken,
  clearToken,
  getAuthUrl,
  exchangeCodeForToken
};
