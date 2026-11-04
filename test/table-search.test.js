'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseQuery, filterRows, splitHighlight } = require('../public/table-search');

const rows = [
  { name: 'Item', path: 'Input/Item.xlsx', cloudName: '道具表', description: '', spreadsheetId: 'abc123' },
  { name: 'ItemShop', path: 'Input/Shop/ItemShop.xlsx', cloudName: '商店', description: '活动商店', spreadsheetId: 'def456' },
  { name: 'Level', path: 'Input/Level.xlsx', cloudName: '关卡', description: '', spreadsheetId: 'ghi789' }
];

test('parseQuery 去空白、转小写、按空白拆分', () => {
  assert.deepStrictEqual(parseQuery('  Item   SHOP '), ['item', 'shop']);
  assert.deepStrictEqual(parseQuery(''), []);
  assert.deepStrictEqual(parseQuery(null), []);
});

test('filterRows 空关键词返回全部', () => {
  assert.strictEqual(filterRows(rows, '  ').length, 3);
});

test('filterRows 大小写不敏感，匹配表名 / 路径 / 云端表名 / 备注 / spreadsheetId', () => {
  assert.deepStrictEqual(filterRows(rows, 'item').map(r => r.name), ['Item', 'ItemShop']);
  assert.deepStrictEqual(filterRows(rows, 'input/shop').map(r => r.name), ['ItemShop']);
  assert.deepStrictEqual(filterRows(rows, '关卡').map(r => r.name), ['Level']);
  assert.deepStrictEqual(filterRows(rows, '活动').map(r => r.name), ['ItemShop']);
  assert.deepStrictEqual(filterRows(rows, 'GHI7').map(r => r.name), ['Level']);
});

test('filterRows 多关键词需全部命中', () => {
  assert.deepStrictEqual(filterRows(rows, 'item 商店').map(r => r.name), ['ItemShop']);
  assert.deepStrictEqual(filterRows(rows, 'item 关卡'), []);
});

test('splitHighlight 合并相邻命中片段，保留原始大小写', () => {
  assert.deepStrictEqual(splitHighlight('ItemShop', ['item', 'sh']), [
    { text: 'ItemSh', hit: true }, { text: 'op', hit: false }
  ]);
  assert.deepStrictEqual(splitHighlight('Level', []), [{ text: 'Level', hit: false }]);
  assert.deepStrictEqual(splitHighlight('aaa', ['a']), [{ text: 'aaa', hit: true }]);
});
