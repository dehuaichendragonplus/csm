'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nearestExisting, insideBase } = require('../lib/reveal');

test('insideBase 只允许基准目录之内的路径', () => {
  assert.ok(insideBase('/a/b', '/a/b'));
  assert.ok(insideBase('/a/b', '/a/b/c/d.xlsx'));
  assert.ok(!insideBase('/a/b', '/a/bc/d.xlsx'));
  assert.ok(!insideBase('/a/b', '/a/b/../x'));
  assert.ok(!insideBase('/a/b', '/etc'));
});

test('nearestExisting 不存在时退到最近的存在的上级目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-reveal-'));
  fs.mkdirSync(path.join(dir, 'Datas'));
  fs.writeFileSync(path.join(dir, 'Datas', 'A.xlsx'), 'x');
  assert.strictEqual(nearestExisting(path.join(dir, 'Datas', 'A.xlsx')), path.join(dir, 'Datas', 'A.xlsx'));
  assert.strictEqual(nearestExisting(path.join(dir, 'Datas', 'Item', 'B.xlsx')), path.join(dir, 'Datas'));
});
