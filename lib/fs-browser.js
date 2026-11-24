'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectLegacy } = require('./legacy-import');

// 只列子目录（隐藏目录除外），供前端「选择项目目录」弹窗逐级浏览；标记哪些目录看起来是可添加的项目
function listDirs(dirInput) {
  const dir = path.resolve(dirInput || os.homedir());
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    let hint = false;
    try {
      hint = fs.existsSync(path.join(full, 'syncmanager.config.json')) || fs.existsSync(path.join(full, 'filelist.json')) ||
        fs.existsSync(path.join(full, 'Input/filelist.json'));
    } catch (_) { /* 无权限就当没有 */ }
    dirs.push({ name: e.name, path: full, hint });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(dir);
  const hint = fs.existsSync(path.join(dir, 'syncmanager.config.json')) || fs.existsSync(path.join(dir, 'filelist.json')) ||
    fs.existsSync(path.join(dir, 'Input/filelist.json'));
  // 没有配置也没有清单时，看看是不是老项目（有本地 xlsx / 附近导表脚本里有表格链接），可以自动生成配置
  let legacy = null;
  if (!hint) {
    try {
      const info = inspectLegacy(dir);
      if (info.ok) legacy = { tables: info.tables, tablesTruncated: info.tablesTruncated, mapped: info.mapped, unmapped: info.unmapped, sources: info.sources };
    } catch (_) { /* 读不了就当不是 */ }
  }
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    hint,
    legacy,
    dirs
  };
}

module.exports = { listDirs };
