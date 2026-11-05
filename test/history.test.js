const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { appendHistory, readHistory, trimHistory } = require('../lib/history');

test('appendHistory / readHistory：新的在前，可按 path 过滤，坏行跳过', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'csm-h-')), 'p', 'history.jsonl');
  appendHistory(file, { op: 'download', path: 'a.xlsx' });
  appendHistory(file, { op: 'upload', path: 'b.xlsx' });
  fs.appendFileSync(file, 'not json\n');
  appendHistory(file, { op: 'download', path: 'a.xlsx', ok: true });
  const all = readHistory(file);
  assert.deepStrictEqual(all.map(r => r.op), ['download', 'upload', 'download']);
  assert.ok(all[0].time);
  assert.strictEqual(readHistory(file, { path: 'a.xlsx' }).length, 2);
  assert.strictEqual(readHistory(file, { limit: 1 }).length, 1);
});

test('trimHistory 只保留最近 max 条；文件不存在时 readHistory 返回空', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'csm-h-')), 'history.jsonl');
  assert.deepStrictEqual(readHistory(file), []);
  for (let i = 0; i < 10; i++) appendHistory(file, { op: 'download', n: i });
  trimHistory(file, 4);
  assert.deepStrictEqual(readHistory(file).map(r => r.n), [9, 8, 7, 6]);
});
