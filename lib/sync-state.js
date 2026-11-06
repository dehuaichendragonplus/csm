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

// 文件内容指纹：git 切分支 / 拉取会改修改时间但不改内容，靠它区分「真的改过」。
// 按路径和文件属性缓存，覆盖写入或替换文件后会重新计算。
const fileVersion = st => `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
const hashCache = new Map(); // absPath -> { version, hash }
const HASH_CACHE_MAX = 5000;

function hashFile(filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch (_) { return null; }
  const key = path.resolve(filePath);
  const version = fileVersion(st);
  const hit = hashCache.get(key);
  if (hit && hit.version === version) return hit.hash;
  let hash;
  try { hash = crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex'); } catch (_) { return null; }
  if (hashCache.size >= HASH_CACHE_MAX) hashCache.delete(hashCache.keys().next().value);
  hashCache.set(key, { version, hash });
  return hash;
}

module.exports = { loadState, saveState, updateEntry, hashFile, fileVersion };
