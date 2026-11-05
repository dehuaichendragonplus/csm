'use strict';
// 操作历史：每个项目一份 JSON Lines（本机记录），记下谁在什么时候对哪张表做了下载 / 上传 / 恢复 / 动作。
const fs = require('node:fs');
const path = require('node:path');

const MAX_LINES = 2000;    // 超过后只保留最近这么多条
const TRIM_EVERY = 200;    // 每写这么多条检查一次是否需要裁剪

const writes = new Map();

function appendHistory(file, record) {
  const row = { time: new Date().toISOString(), ...record };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  const n = (writes.get(file) || 0) + 1;
  writes.set(file, n);
  if (n % TRIM_EVERY === 0) trimHistory(file);
  return row;
}

function readHistory(file, { limit = 200, path: tablePath, op } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i]) continue;
    let row;
    try { row = JSON.parse(lines[i]); } catch (_) { continue; }
    if (tablePath && row.path !== tablePath) continue;
    if (op && row.op !== op) continue;
    out.push(row);
  }
  return out; // 新的在前
}

function trimHistory(file, max = MAX_LINES) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch (_) { return; }
  if (lines.length <= max) return;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, lines.slice(-max).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { appendHistory, readHistory, trimHistory, MAX_LINES };
