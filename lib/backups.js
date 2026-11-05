'use strict';
// 本地 xlsx 备份：下载（云端覆盖本地）和恢复前，先把当前本地文件存一份，误覆盖后可一键找回。
// 目录：<备份根目录>/<表的相对路径>/<时间戳>.xlsx，每张表保留最近 keep 份；内容和最近一份相同时不重复保存。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_KEEP = 10;

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

// 表的相对路径 → 备份子目录（只允许落在备份根目录之内）
function dirFor(root, relPath) {
  const safe = String(relPath || '').replace(/\\/g, '/').split('/').filter(s => s && s !== '.' && s !== '..').join('/');
  if (!safe) throw new Error('无效的表路径');
  return path.join(root, safe);
}

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// 列出某张表的备份，新的在前
function listBackups(root, relPath) {
  const dir = dirFor(root, relPath);
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names
    .filter(n => /\.xlsx$/i.test(n))
    .map(n => {
      const st = fs.statSync(path.join(dir, n));
      const meta = readMeta(dir, n);
      return { id: n, size: st.size, createdAt: meta.createdAt || st.mtime.toISOString(), reason: meta.reason || null, hash: meta.hash || null };
    })
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

function metaPath(dir, id) { return path.join(dir, `${id}.json`); }
function readMeta(dir, id) {
  try { return JSON.parse(fs.readFileSync(metaPath(dir, id), 'utf8')); } catch (_) { return {}; }
}

/**
 * 备份当前本地文件；文件不存在时返回 null。
 * 返回 { id, size, deduped }：deduped=true 表示和最近一份内容相同，没有新建。
 */
function backupFile(root, relPath, absPath, { reason = '', keep = DEFAULT_KEEP, now = new Date() } = {}) {
  let buf;
  try { buf = fs.readFileSync(absPath); } catch (_) { return null; }
  const dir = dirFor(root, relPath);
  const hash = sha1(buf);
  const latest = listBackups(root, relPath)[0];
  if (latest && latest.hash === hash) return { id: latest.id, size: latest.size, deduped: true };
  fs.mkdirSync(dir, { recursive: true });
  let id = `${stamp(now)}.xlsx`;
  for (let i = 1; fs.existsSync(path.join(dir, id)); i++) id = `${stamp(now)}-${i}.xlsx`;
  fs.writeFileSync(path.join(dir, id), buf);
  fs.writeFileSync(metaPath(dir, id), JSON.stringify({ createdAt: now.toISOString(), reason, hash, size: buf.length }) + '\n');
  prune(root, relPath, keep);
  return { id, size: buf.length, deduped: false };
}

function prune(root, relPath, keep = DEFAULT_KEEP) {
  const dir = dirFor(root, relPath);
  for (const b of listBackups(root, relPath).slice(Math.max(1, keep))) {
    fs.rmSync(path.join(dir, b.id), { force: true });
    fs.rmSync(metaPath(dir, b.id), { force: true });
  }
}

function backupPath(root, relPath, id) {
  if (!/^[\w.-]+\.xlsx$/i.test(String(id || ''))) throw new Error('无效的备份 ID');
  const p = path.join(dirFor(root, relPath), id);
  if (!fs.existsSync(p)) throw new Error('备份不存在或已被清理');
  return p;
}

// 用备份覆盖本地文件；覆盖前先把当前本地文件也备份一份（恢复错了还能再恢复回来）
function restoreBackup(root, relPath, id, absPath, opts = {}) {
  const src = backupPath(root, relPath, id);
  const before = backupFile(root, relPath, absPath, { ...opts, reason: '恢复前自动备份' });
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, absPath);
  return { restored: id, backupBefore: before };
}

module.exports = { listBackups, backupFile, restoreBackup, backupPath, prune, DEFAULT_KEEP };
