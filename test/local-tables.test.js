'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanRootOf, scanLocalTables, subDirsUnder, isTableFile } = require('../lib/local-tables');

function makeTree(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-local-'));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(base, f)), { recursive: true });
    fs.writeFileSync(path.join(base, f), 'PK');
  }
  return base;
}

test('scanRootOf：配置优先，其次清单最常见首级目录，默认 Datas', () => {
  assert.strictEqual(scanRootOf([{ path: 'Datas/A.xlsx' }], 'Tables/'), 'Tables');
  assert.strictEqual(scanRootOf([{ path: 'X/A.xlsx' }, { path: 'X/B/C.xlsx' }, { path: 'Datas/D.xlsx' }]), 'X');
  assert.strictEqual(scanRootOf([{ path: 'A.xlsx' }]), 'Datas');
  assert.strictEqual(scanRootOf([]), 'Datas');
});

test('isTableFile 排除 Excel 临时文件与隐藏文件', () => {
  assert.ok(isTableFile('A.xlsx'));
  assert.ok(isTableFile('A.XLSX'));
  assert.ok(!isTableFile('~$A.xlsx'));
  assert.ok(!isTableFile('.A.xlsx'));
  assert.ok(!isTableFile('A.xls'));
});

test('scanLocalTables 只列 localRoot 下、且不在清单里的 xlsx（大小写不敏感）', () => {
  const base = makeTree([
    'Datas/Activity/A.xlsx',
    'Datas/Activity/B.xlsx',
    'Datas/Item/Deep/C.xlsx',
    'Datas/~$A.xlsx',
    'Datas/.hidden/D.xlsx',
    'Datas/readme.txt',
    'Other/E.xlsx'
  ]);
  const list = scanLocalTables(base, 'Datas', [{ path: 'datas/activity/a.xlsx' }]);
  assert.deepStrictEqual(list.map(t => t.path), ['Datas/Activity/B.xlsx', 'Datas/Item/Deep/C.xlsx']);
  assert.strictEqual(list[0].name, 'B');
  assert.strictEqual(list[0].size, 2);
  assert.deepStrictEqual(scanLocalTables(base, 'NotExist', []), []);
});

test('subDirsUnder 计算相对 localRoot 的子目录（用于镜像到云端）', () => {
  assert.deepStrictEqual(subDirsUnder('Datas/Activity/A.xlsx', 'Datas'), ['Activity']);
  assert.deepStrictEqual(subDirsUnder('Datas/Item/Deep/C.xlsx', 'Datas'), ['Item', 'Deep']);
  assert.deepStrictEqual(subDirsUnder('Datas/A.xlsx', 'Datas'), []);
  assert.deepStrictEqual(subDirsUnder('datas/A.xlsx', 'Datas'), []);
  assert.strictEqual(subDirsUnder('Other/A.xlsx', 'Datas'), null);
  assert.deepStrictEqual(subDirsUnder('A/B/C.xlsx', 'A/B'), []);
  assert.strictEqual(subDirsUnder('Datas', 'Datas'), null);
});
