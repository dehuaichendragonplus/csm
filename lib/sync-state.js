'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadState(statePath) {
  if (!fs.existsSync(statePath)) return {};
  const raw = fs.readFileSync(statePath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_err) {
    const bak = `${statePath}.bak.${Date.now()}`;
    fs.renameSync(statePath, bak);
    return {};
  }
}

function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function updateEntry(statePath, key, entry) {
  const state = loadState(statePath);
  state[key] = { lastSyncedAt: new Date().toISOString(), ...entry };
  saveState(statePath, state);
  return state;
}

// 文件内容指纹：git 切分支 / 拉取会改修改时间但不改内容，靠它区分「真的改过」
function hashFile(filePath) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex'); } catch (_) { return null; }
}

module.exports = { loadState, saveState, updateEntry, hashFile };
