'use strict';
// 本地表：本地目录（如 Configs/Input/Datas）下存在、但还没加入 filelist.json 的 xlsx
const fs = require('node:fs');
const path = require('node:path');

const MAX_DEPTH = 10;

const toPosix = p => String(p || '').replace(/\\/g, '/');

// 扫描目录：filelist 所在目录下的 localRoot（默认 Datas）。
// 优先用配置的映射；否则取清单里最常见的首级目录；都没有时用 Datas
function scanRootOf(entries, configuredLocal) {
  if (configuredLocal != null && configuredLocal !== '') return toPosix(configuredLocal).replace(/\/+$/, '');
  const counts = new Map();
  for (const e of entries || []) {
    const parts = toPosix(e && e.path).split('/').filter(Boolean);
    if (parts.length < 2) continue;
    counts.set(parts[0], (counts.get(parts[0]) || 0) + 1);
  }
  let best = 'Datas';
  let max = 0;
  for (const [k, n] of counts) if (n > max) { best = k; max = n; }
  return best;
}

// 忽略：Excel 临时文件（~$）、隐藏文件、Luban 定义表（__beans__ / __enums__ / __tables__ / __template__ 等 __xxx__.xlsx）
function isTableFile(name) {
  if (!/\.xlsx$/i.test(name) || name.startsWith('~$') || name.startsWith('.')) return false;
  return !/^__.*__$/.test(name.replace(/\.xlsx$/i, ''));
}

// 返回 [{ path（相对 baseDir）, name（不含扩展名）, size, mtime }]
function scanLocalTables(baseDir, localRoot, entries) {
  const inList = new Set((entries || []).map(e => toPosix(e && e.path).replace(/^\.\//, '').toLowerCase()));
  const rootAbs = path.resolve(baseDir, localRoot || '.');
  const out = [];
  if (!rootAbs.startsWith(path.resolve(baseDir))) return out;
  (function walk(dir, depth) {
    if (depth > MAX_DEPTH) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      if (it.name.startsWith('.')) continue;
      const abs = path.join(dir, it.name);
      if (it.isDirectory()) { walk(abs, depth + 1); continue; }
      if (!it.isFile() || !isTableFile(it.name)) continue;
      const rel = toPosix(path.relative(baseDir, abs));
      if (inList.has(rel.toLowerCase())) continue;
      let st;
      try { st = fs.statSync(abs); } catch (_) { continue; }
      out.push({ path: rel, name: it.name.replace(/\.xlsx$/i, ''), size: st.size, mtime: st.mtime.toISOString() });
    }
  })(rootAbs, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// 本地路径相对 localRoot 的子目录（用于对应云端子目录）；不在 localRoot 下返回 null
// 例：('Datas/Activity/A.xlsx', 'Datas') → ['Activity']；('Datas/A.xlsx', 'Datas') → []
function subDirsUnder(localPath, localRoot) {
  const parts = toPosix(localPath).split('/').filter(Boolean);
  const rootParts = toPosix(localRoot).split('/').filter(Boolean);
  if (parts.length <= rootParts.length) return null;
  for (let i = 0; i < rootParts.length; i++) {
    if (parts[i].toLowerCase() !== rootParts[i].toLowerCase()) return null;
  }
  return parts.slice(rootParts.length, -1);
}

module.exports = { scanRootOf, scanLocalTables, subDirsUnder, isTableFile };
