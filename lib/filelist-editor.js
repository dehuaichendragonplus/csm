'use strict';
// filelist.json 的读写与编辑：增 / 删 / 改条目，解析 Google 表格链接，按云端表名推荐表名与路径。
// 写回时保留原文件的缩进、末尾换行与字段顺序，尽量让 git diff 只包含真正改动的条目。
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_KEY_ORDER = ['path', 'spreadsheetId', 'description', 'name'];

function editorError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// ---------- 链接解析 ----------

// 支持：docs.google.com/spreadsheets/d/<id>/...、drive.google.com/file/d/<id>/...、
// ...?id=<id>（open / uc 链接）、以及直接粘贴的 ID
function parseSpreadsheetId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const byPath = s.match(/\/(?:spreadsheets\/(?:u\/\d+\/)?d|file\/d|document\/d)\/([A-Za-z0-9_-]{20,})/);
  if (byPath) return byPath[1];
  const byQuery = s.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  if (byQuery) return byQuery[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  return null;
}

// ---------- 推荐表名 / 路径 ----------

// 云端表名常见形态：「MX11-DeepBoard2（深度小棋盘2-购物节）」「BattlePass_15-森林」「Global」
// 拆成：英文标识（去掉项目前缀，用作文件名）+ 括号里的中文（用作表名）
function splitCloudName(cloudName) {
  const full = String(cloudName || '').trim().replace(/\.xlsx$/i, '');
  const paren = full.match(/^(.*?)\s*[（(]([^（）()]+)[）)]\s*$/);
  const head = (paren ? paren[1] : full).trim();
  const label = paren ? paren[2].trim() : '';
  const noPrefix = head.replace(/^[A-Z][A-Z0-9]{1,6}-(?=.)/, '');
  return { head: noPrefix, label };
}

function sanitizeFileBase(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .trim();
}

// 最常用的目录作为默认存放目录（如 Datas/Activity）
function mostCommonDir(entries) {
  const counts = new Map();
  for (const e of entries) {
    if (!e || typeof e.path !== 'string') continue;
    const dir = path.posix.dirname(e.path.replace(/\\/g, '/'));
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  let best = '';
  let max = 0;
  for (const [dir, n] of counts) if (n > max) { best = dir; max = n; }
  return best === '.' ? '' : best;
}

function listDirs(entries) {
  const set = new Set();
  for (const e of entries) {
    if (!e || typeof e.path !== 'string') continue;
    const dir = path.posix.dirname(e.path.replace(/\\/g, '/'));
    if (dir && dir !== '.') set.add(dir);
  }
  return [...set].sort();
}

function suggestEntry(cloudName, entries, dir) {
  const { head, label } = splitCloudName(cloudName);
  const base = sanitizeFileBase(head) || sanitizeFileBase(cloudName) || 'NewTable';
  const targetDir = dir !== undefined ? dir : mostCommonDir(entries);
  return {
    name: label || head || String(cloudName || '').trim(),
    description: String(cloudName || '').trim(),
    path: targetDir ? `${targetDir}/${base}.xlsx` : `${base}.xlsx`
  };
}

// ---------- 校验 ----------

function normalizePath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

function validateEntry(input, entries, { originalPath = null, allowDuplicateId = false } = {}) {
  if (!input || typeof input !== 'object') throw editorError('INVALID', '条目不能为空');
  const entryPath = normalizePath(input.path);
  if (!entryPath) throw editorError('INVALID', '本地路径不能为空');
  if (!/\.xlsx$/i.test(entryPath)) throw editorError('INVALID', '本地路径必须以 .xlsx 结尾');
  if (path.posix.isAbsolute(entryPath) || /^[A-Za-z]:/.test(entryPath)) throw editorError('INVALID', '本地路径必须是相对 filelist.json 所在目录的相对路径');
  const norm = path.posix.normalize(entryPath);
  if (norm === '..' || norm.startsWith('../')) throw editorError('INVALID', '本地路径不能跳出 filelist.json 所在目录');

  const spreadsheetId = String(input.spreadsheetId || '').trim();
  if (!spreadsheetId) throw editorError('INVALID', 'spreadsheetId 不能为空（可粘贴 Google 表格链接自动解析）');
  if (!/^[A-Za-z0-9_-]{20,}$/.test(spreadsheetId)) throw editorError('INVALID', 'spreadsheetId 格式不正确');

  const name = String(input.name || '').trim();
  if (!name) throw editorError('INVALID', '表名不能为空');

  const others = entries.filter(e => normalizePath(e.path) !== normalizePath(originalPath || ''));
  if (others.some(e => normalizePath(e.path).toLowerCase() === norm.toLowerCase())) {
    throw editorError('DUPLICATE_PATH', `清单里已有路径相同的条目：${norm}`);
  }
  const sameId = others.filter(e => String(e.spreadsheetId || '').trim() === spreadsheetId);
  if (sameId.length && !allowDuplicateId) {
    throw editorError('DUPLICATE_ID', `这个云端表已在清单中：${sameId.map(e => e.path).join('、')}`, {
      paths: sameId.map(e => e.path)
    });
  }

  return {
    path: norm,
    spreadsheetId,
    description: String(input.description == null ? '' : input.description).trim(),
    name
  };
}

// ---------- 读写 ----------

function detectFormat(raw) {
  const m = raw.match(/\n([ \t]+)\S/);
  return { indent: m ? m[1] : '  ', trailingNewline: /\n\s*$/.test(raw) };
}

function readFilelistRaw(filelistPath) {
  if (!fs.existsSync(filelistPath)) throw editorError('NOT_FOUND', `filelist 不存在：${filelistPath}`);
  const raw = fs.readFileSync(filelistPath, 'utf8');
  let entries;
  try { entries = JSON.parse(raw); } catch (err) { throw editorError('INVALID_JSON', `filelist 不是合法 JSON：${err.message}`); }
  if (!Array.isArray(entries)) throw editorError('INVALID_JSON', 'filelist 必须是 JSON 数组');
  return { entries, format: detectFormat(raw) };
}

function writeFilelistRaw(filelistPath, entries, format) {
  const fmt = format || { indent: '  ', trailingNewline: true };
  const text = JSON.stringify(entries, null, fmt.indent) + (fmt.trailingNewline ? '\n' : '');
  const tmp = `${filelistPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filelistPath);
}

// 新条目的字段顺序沿用清单里已有条目的顺序，其余字段（如 mergeCells）放后面
function orderKeys(obj, template) {
  const order = template && typeof template === 'object' ? Object.keys(template) : DEFAULT_KEY_ORDER;
  const out = {};
  for (const k of order) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];
  return out;
}

function addEntry(filelistPath, input, opts = {}) {
  const { entries, format } = readFilelistRaw(filelistPath);
  const clean = validateEntry(input, entries, { allowDuplicateId: !!opts.allowDuplicateId });
  const entry = orderKeys(clean, entries[0]);
  entries.push(entry);
  writeFilelistRaw(filelistPath, entries, format);
  return entry;
}

// 修改：在原条目上合并，保留未知字段（如 mergeCells）与原字段顺序
function updateEntry(filelistPath, originalPath, input, opts = {}) {
  const { entries, format } = readFilelistRaw(filelistPath);
  const idx = entries.findIndex(e => normalizePath(e.path) === normalizePath(originalPath));
  if (idx < 0) throw editorError('NOT_FOUND', `清单里找不到：${originalPath}`);
  const clean = validateEntry(input, entries, { originalPath, allowDuplicateId: !!opts.allowDuplicateId });
  const merged = { ...entries[idx], ...clean };
  entries[idx] = orderKeys(merged, entries[idx]);
  writeFilelistRaw(filelistPath, entries, format);
  return entries[idx];
}

function removeEntry(filelistPath, entryPath) {
  const { entries, format } = readFilelistRaw(filelistPath);
  const idx = entries.findIndex(e => normalizePath(e.path) === normalizePath(entryPath));
  if (idx < 0) throw editorError('NOT_FOUND', `清单里找不到：${entryPath}`);
  const [removed] = entries.splice(idx, 1);
  writeFilelistRaw(filelistPath, entries, format);
  return removed;
}

module.exports = {
  parseSpreadsheetId,
  splitCloudName,
  suggestEntry,
  mostCommonDir,
  listDirs,
  validateEntry,
  readFilelistRaw,
  writeFilelistRaw,
  addEntry,
  updateEntry,
  removeEntry
};
