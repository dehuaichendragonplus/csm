'use strict';
// 在访达 / 资源管理器中定位本地文件或打开目录（服务只监听 127.0.0.1，窗口出现在本机）
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, err => (err && cmd !== 'explorer' ? reject(err) : resolve())); // explorer 成功时也会返回非 0
});

// 不存在时退到最近的存在的上级目录
function nearestExisting(p) {
  let cur = p;
  while (cur && !fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return cur;
}

// target 在 baseDir 之内才允许（防止页面请求打开任意路径）
function insideBase(baseDir, target) {
  const rel = path.relative(path.resolve(baseDir), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function revealPath(target, platform = process.platform) {
  const existing = nearestExisting(target);
  if (!existing) throw new Error(`路径不存在：${target}`);
  const isFile = fs.statSync(existing).isFile();
  if (platform === 'darwin') return run('open', isFile ? ['-R', existing] : [existing]);
  if (platform === 'win32') return run('explorer', isFile ? [`/select,${existing}`] : [existing]);
  return run('xdg-open', [isFile ? path.dirname(existing) : existing]);
}

module.exports = { revealPath, nearestExisting, insideBase };
