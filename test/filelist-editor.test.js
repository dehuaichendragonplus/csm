'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fe = require('../lib/filelist-editor');

const ID1 = '1QdVb8ksLkeyL054m7mmKbB6h0KGuSCNc5kORd3pwrhc';
const ID2 = '1FklWfsMJx86S1Cx5R66CvGodYt3GTzGzNK9MLF835BA';
const ID3 = '19D9DKKbESB9JOKPEm0zQFQddmaKefN8-808UQla6iGM';

function tmpFilelist(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-fl-'));
  const p = path.join(dir, 'filelist.json');
  fs.writeFileSync(p, content);
  return p;
}

const SAMPLE = `[
  {
    "path": "Datas/Activity/A.xlsx",
    "spreadsheetId": "${ID1}",
    "description": "A Sheet",
    "name": "A"
  },
  {
    "path": "Datas/Activity/B.xlsx",
    "spreadsheetId": "${ID2}",
    "description": "B Sheet",
    "name": "B",
    "mergeCells": true
  }
]`;

test('parseSpreadsheetId 支持各种链接形态与纯 ID', () => {
  assert.strictEqual(fe.parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${ID1}/edit#gid=0`), ID1);
  assert.strictEqual(fe.parseSpreadsheetId(`https://docs.google.com/spreadsheets/u/1/d/${ID1}/edit?usp=sharing`), ID1);
  assert.strictEqual(fe.parseSpreadsheetId(`https://drive.google.com/file/d/${ID1}/view`), ID1);
  assert.strictEqual(fe.parseSpreadsheetId(`https://drive.google.com/open?id=${ID1}`), ID1);
  assert.strictEqual(fe.parseSpreadsheetId(`  ${ID1}  `), ID1);
  assert.strictEqual(fe.parseSpreadsheetId('https://example.com/abc'), null);
  assert.strictEqual(fe.parseSpreadsheetId(''), null);
});

test('splitCloudName 去项目前缀、拆出括号里的中文名', () => {
  assert.deepStrictEqual(fe.splitCloudName('MX11-DeepBoard2（深度小棋盘2-购物节）'), { head: 'DeepBoard2', label: '深度小棋盘2-购物节' });
  assert.deepStrictEqual(fe.splitCloudName('BattlePass_7（战令7）'), { head: 'BattlePass_7', label: '战令7' });
  assert.deepStrictEqual(fe.splitCloudName('Global'), { head: 'Global', label: '' });
  assert.deepStrictEqual(fe.splitCloudName('BattlePass_15-森林'), { head: 'BattlePass_15-森林', label: '' });
  assert.deepStrictEqual(fe.splitCloudName('Item.xlsx'), { head: 'Item', label: '' });
});

test('suggestEntry 默认放到最常用目录，描述保留完整云端表名', () => {
  const entries = [{ path: 'Datas/Activity/A.xlsx' }, { path: 'Datas/Activity/B.xlsx' }, { path: 'Datas/Global.xlsx' }];
  assert.deepStrictEqual(fe.suggestEntry('MX11-DeepBoard9（深度小棋盘9-奢侈品）', entries), {
    name: '深度小棋盘9-奢侈品',
    description: 'MX11-DeepBoard9（深度小棋盘9-奢侈品）',
    path: 'Datas/Activity/DeepBoard9.xlsx'
  });
  assert.strictEqual(fe.suggestEntry('Global Config', [], undefined).path, 'Global_Config.xlsx');
  assert.strictEqual(fe.suggestEntry('X', entries, 'Datas').path, 'Datas/X.xlsx');
});

test('validateEntry 校验路径、ID、表名与重复', () => {
  const entries = JSON.parse(SAMPLE);
  const ok = { path: './Datas/C.xlsx', spreadsheetId: ID3, name: 'C', description: ' d ' };
  assert.deepStrictEqual(fe.validateEntry(ok, entries), { path: 'Datas/C.xlsx', spreadsheetId: ID3, description: 'd', name: 'C' });
  assert.throws(() => fe.validateEntry({ ...ok, path: 'Datas/C.csv' }, entries), /\.xlsx/);
  assert.throws(() => fe.validateEntry({ ...ok, path: '/abs/C.xlsx' }, entries), /相对路径/);
  assert.throws(() => fe.validateEntry({ ...ok, path: '../C.xlsx' }, entries), /跳出/);
  assert.throws(() => fe.validateEntry({ ...ok, spreadsheetId: '' }, entries), /spreadsheetId/);
  assert.throws(() => fe.validateEntry({ ...ok, name: ' ' }, entries), /表名/);
  assert.throws(() => fe.validateEntry({ ...ok, path: 'datas/activity/a.xlsx' }, entries), e => e.code === 'DUPLICATE_PATH');
  assert.throws(() => fe.validateEntry({ ...ok, spreadsheetId: ID1 }, entries), e => e.code === 'DUPLICATE_ID' && e.paths[0] === 'Datas/Activity/A.xlsx');
  assert.strictEqual(fe.validateEntry({ ...ok, spreadsheetId: ID1 }, entries, { allowDuplicateId: true }).spreadsheetId, ID1);
  // 修改自身时不算重复
  assert.strictEqual(fe.validateEntry({ ...entries[0] }, entries, { originalPath: 'Datas/Activity/A.xlsx' }).path, 'Datas/Activity/A.xlsx');
});

test('addEntry 追加条目，沿用原缩进、字段顺序与「无末尾换行」', () => {
  const p = tmpFilelist(SAMPLE);
  fe.addEntry(p, { name: 'C', path: 'Datas/C.xlsx', description: 'C Sheet', spreadsheetId: ID3 });
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.startsWith(SAMPLE.slice(0, -2)), '原有内容逐字保留');
  assert.ok(!raw.endsWith('\n'));
  const last = JSON.parse(raw)[2];
  assert.deepStrictEqual(Object.keys(last), ['path', 'spreadsheetId', 'description', 'name']);
});

test('addEntry 保留末尾换行；空清单使用默认字段顺序', () => {
  const p = tmpFilelist('[\n  \n]\n');
  fe.addEntry(p, { name: 'C', path: 'C.xlsx', spreadsheetId: ID3 });
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.deepStrictEqual(JSON.parse(raw), [{ path: 'C.xlsx', spreadsheetId: ID3, description: '', name: 'C' }]);
});

test('updateEntry 合并修改并保留未知字段（mergeCells）', () => {
  const p = tmpFilelist(SAMPLE);
  fe.updateEntry(p, 'Datas/Activity/B.xlsx', { path: 'Datas/Activity/B2.xlsx', spreadsheetId: ID2, name: 'B2', description: 'B2 Sheet' });
  const list = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepStrictEqual(list[1], { path: 'Datas/Activity/B2.xlsx', spreadsheetId: ID2, description: 'B2 Sheet', name: 'B2', mergeCells: true });
  assert.throws(() => fe.updateEntry(p, 'nope.xlsx', list[0]), e => e.code === 'NOT_FOUND');
});

test('removeEntry 删除指定条目，其余不变', () => {
  const p = tmpFilelist(SAMPLE);
  const removed = fe.removeEntry(p, 'Datas/Activity/A.xlsx');
  assert.strictEqual(removed.name, 'A');
  const list = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepStrictEqual(list.map(e => e.name), ['B']);
  assert.throws(() => fe.removeEntry(p, 'Datas/Activity/A.xlsx'), e => e.code === 'NOT_FOUND');
});

test('readFilelistRaw 对非法 JSON 与非数组报错', () => {
  assert.throws(() => fe.readFilelistRaw(tmpFilelist('{')), e => e.code === 'INVALID_JSON');
  assert.throws(() => fe.readFilelistRaw(tmpFilelist('{}')), e => e.code === 'INVALID_JSON');
});
