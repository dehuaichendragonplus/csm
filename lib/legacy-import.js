'use strict';
// 老项目接入：目录里既没有 syncmanager.config.json 也没有 filelist.json，但有本地 xlsx。
// 自动生成 filelist.json + 最小配置，让老项目也能直接打开；
// 并从附近的导表脚本（如 ExcelTools/bcModule.sh 里的 {"Game","<spreadsheetId>","../Configs/Modules/Game.xlsx"}）
// 识别「本地 xlsx ↔ 云端表」的对应关系，预填进清单。
const fs = require('node:fs');
const path = require('node:path');
const { isTableFile } = require('./local-tables');

const LEGACY_FILELIST = 'filelist.json';
const SCRIPT_EXT = /\.(sh|command|bat|cmd|ps1|py)$/i;
const MAX_SCRIPT_FILES = 300;
const MAX_SCRIPT_SIZE = 1024 * 1024;
const COUNT_MAX_DEPTH = 6;

const toPosix = p => String(p || '').replace(/\\/g, '/');

// 本地配置表数量（忽略隐藏目录、Excel 临时文件和 Luban 定义表）。
// 浏览目录时会对任意目录调用，所以有上限：数到 limit 张或遍历 maxDirs 个目录就停（truncated = true）
function countLocalTables(dir, { limit = 5000, maxDirs = 800 } = {}) {
  const root = path.resolve(dir);
  const paths = [];
  let n = 0;
  let dirs = 0;
  let truncated = false;
  (function walk(d, depth) {
    if (truncated || depth > COUNT_MAX_DEPTH) return;
    if (++dirs > maxDirs) { truncated = true; return; }
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      if (truncated) return;
      if (it.name.startsWith('.') || it.name === 'node_modules') continue;
      if (it.isDirectory()) walk(path.join(d, it.name), depth + 1);
      else if (it.isFile() && isTableFile(it.name)) {
        paths.push(toPosix(path.relative(root, path.join(d, it.name))));
        if (++n >= limit) truncated = true;
      }
    }
  })(root, 0);
  return { count: n, truncated, paths };
}

// 去找脚本的目录：配置表目录本身、它的子目录、上一级、上一级的其他子目录（如 Res/ExcelTools）
function scriptDirs(dir) {
  const out = [];
  const seen = new Set();
  const add = d => { if (!seen.has(d)) { seen.add(d); out.push(d); } };
  const subdirs = d => {
    try {
      return fs.readdirSync(d, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map(e => path.join(d, e.name));
    } catch (_) { return []; }
  };
  add(dir);
  subdirs(dir).forEach(add);
  const parent = path.dirname(dir);
  if (parent !== dir) {
    add(parent);
    subdirs(parent).forEach(add);
  }
  return out;
}

function isCommentLine(line) {
  const t = line.trim();
  return !t || t.startsWith('#') || t.startsWith('//') || t.startsWith('::') || t.startsWith(';') || /^rem\s/i.test(t);
}

// 一行里的 spreadsheetId：docs 链接里的 /d/<id>，或 30~60 位、同时含字母和数字的独立 token
function idsInLine(line) {
  const ids = new Set();
  for (const m of line.matchAll(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/g)) ids.add(m[1]);
  for (const m of line.matchAll(/(?<![A-Za-z0-9_\-./\\])([A-Za-z0-9_-]{30,60})(?![A-Za-z0-9_\-./\\])/g)) {
    if (/[0-9]/.test(m[1]) && /[A-Za-z]/.test(m[1])) ids.add(m[1]);
  }
  return [...ids];
}

function xlsxInLine(line) {
  const out = [];
  for (const m of line.matchAll(/["']?([^"'\s,{}()=]+\.xlsx)\b/gi)) {
    if (/[$%]/.test(m[1])) continue; // 含变量的路径无法解析
    out.push(m[1]);
  }
  return out;
}

// 行内引号里的第一个「名字」：排除 id 和 xlsx 路径
function nameInLine(line, id, xlsx) {
  for (const m of line.matchAll(/"([^"]*)"|'([^']*)'/g)) {
    const s = (m[1] != null ? m[1] : m[2]).trim();
    if (!s || s.includes(id) || /\.xlsx$/i.test(s) || s.length > 60 || /[/\\$%]/.test(s)) continue;
    return s;
  }
  return path.basename(toPosix(xlsx)).replace(/\.xlsx$/i, '');
}

/**
 * 扫描附近的脚本，找出「同一行同时出现 spreadsheetId 和 xlsx 路径」的映射，且 xlsx 落在 dir 之内。
 * 返回 { entries: [{ path（相对 dir）, spreadsheetId, name }], sources: [脚本相对 dir 的路径] }
 */
function findScriptMappings(dir) {
  const root = path.resolve(dir);
  const byPath = new Map();
  const sources = new Set();
  let scanned = 0;
  for (const d of scriptDirs(root)) {
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const it of items) {
      if (!it.isFile() || !SCRIPT_EXT.test(it.name)) continue;
      if (++scanned > MAX_SCRIPT_FILES) break;
      const file = path.join(d, it.name);
      let text;
      try {
        if (fs.statSync(file).size > MAX_SCRIPT_SIZE) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch (_) { continue; }
      for (const line of text.split(/\r?\n/)) {
        if (isCommentLine(line)) continue;
        const ids = idsInLine(line);
        if (ids.length !== 1) continue;
        for (const x of xlsxInLine(line)) {
          const abs = path.resolve(d, toPosix(x));
          const rel = path.relative(root, abs);
          if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
          const relPosix = toPosix(rel);
          if (byPath.has(relPosix.toLowerCase())) continue; // 先出现的为准
          byPath.set(relPosix.toLowerCase(), { path: relPosix, spreadsheetId: ids[0], name: nameInLine(line, ids[0], x) });
          sources.add(toPosix(path.relative(root, file)));
        }
      }
    }
  }
  const entries = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { entries, sources: [...sources].sort() };
}

/** 目录能否按老项目方式接入：附近脚本里识别到映射，或有本地 xlsx（且目录不是大到数不完） */
function inspectLegacy(dir, countOptions) {
  const { count: tables, truncated, paths } = countLocalTables(dir, countOptions);
  const { entries, sources } = findScriptMappings(dir);
  const mappedPaths = new Set(entries.map(e => e.path.toLowerCase()));
  const unmapped = paths.filter(p => !mappedPaths.has(p.toLowerCase())).length;
  // 目录太大（数不完）多半是选错了上层目录（如主目录），除非脚本里明确指到这里，否则不按老项目接入
  return {
    tables, tablesTruncated: truncated, mapped: entries.length, unmapped, entries, sources,
    ok: entries.length > 0 || (tables > 0 && !truncated)
  };
}

/** 在 dir 下生成 filelist.json（不覆盖已有文件），返回 { filelistPath, mapped, tables, sources } */
function generateLegacyFilelist(dir) {
  const info = inspectLegacy(dir);
  if (!info.ok) return null;
  const filelistPath = path.join(dir, LEGACY_FILELIST);
  if (fs.existsSync(filelistPath)) throw new Error(`${LEGACY_FILELIST} 已存在，不会覆盖`);
  fs.writeFileSync(filelistPath, JSON.stringify(info.entries, null, 2) + '\n', 'utf8');
  return { filelistPath, mapped: info.mapped, unmapped: info.unmapped, tables: info.tables, sources: info.sources };
}

module.exports = { countLocalTables, findScriptMappings, inspectLegacy, generateLegacyFilelist, LEGACY_FILELIST };
