'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseActionError, cleanErrorLine } = require('../public/action-error-parser');

const MOCK_ROWS = [
  { name: 'ItemConfig', path: 'Datas/Item/ItemConfig.xlsx', spreadsheetId: 'sheet_item_123' },
  { name: 'ShopMall', path: 'Datas/Shop/ShopMall.xlsx', spreadsheetId: 'sheet_shop_456' },
  { name: 'BadWordFilter', path: 'BadWordFilter/BadWordFilter.xlsx', spreadsheetId: 'sheet_bad_789' }
];

test('parseActionError: 典型 Luban 格式 table, record, field 提取与已知表匹配', () => {
  const log = `
→ Luban导出…
[INFO] loading schema...
[ERROR] table:ItemConfig record:1001 field:itemId type mismatch: expected int, got "string"
=== done: success=0 failed=1 exit=1 ===
  `;

  const res = parseActionError(log, MOCK_ROWS);
  assert.ok(res);
  assert.equal(res.hasError, true);
  assert.equal(res.tableName, 'ItemConfig');
  assert.equal(res.record, '1001');
  assert.equal(res.field, 'itemId');
  assert.ok(res.matchedRow);
  assert.equal(res.matchedRow.spreadsheetId, 'sheet_item_123');
  assert.equal(res.filePath, 'Datas/Item/ItemConfig.xlsx');
  assert.match(res.summary, /配置表「ItemConfig」/);
  assert.match(res.summary, /字段: itemId/);
});

test('parseActionError: 带 sheet 与 line 的错误格式', () => {
  const log = `
Running gen_client.sh...
ERROR: table:ShopMall sheet:Goods line:42 field:price value is negative (-500)
command failed with exit code 2
  `;

  const res = parseActionError(log, MOCK_ROWS);
  assert.ok(res);
  assert.equal(res.tableName, 'ShopMall');
  assert.equal(res.sheetName, 'Goods');
  assert.equal(res.lineNum, '42');
  assert.equal(res.field, 'price');
  assert.ok(res.matchedRow);
  assert.equal(res.matchedRow.path, 'Datas/Shop/ShopMall.xlsx');
});

test('parseActionError: 异常回溯中通过已知表名反查匹配', () => {
  const log = `
System.Exception: failed to validate Datas/Shop/ShopMall.xlsx: duplicate key 2005
   at Luban.DataTarget.ExcelReader.Process()
  `;

  const res = parseActionError(log, MOCK_ROWS);
  assert.ok(res);
  assert.equal(res.tableName, 'ShopMall');
  assert.ok(res.matchedRow);
  assert.equal(res.matchedRow.name, 'ShopMall');
});

test('parseActionError: 无特定表格的通用脚本报错降级处理', () => {
  const log = `
→ Luban导出…
bash: dotnet: command not found
=== done: success=0 failed=1 exit=127 ===
  `;

  const res = parseActionError(log, MOCK_ROWS);
  assert.ok(res);
  assert.equal(res.hasError, true);
  assert.equal(res.tableName, null);
  assert.equal(res.matchedRow, null);
  assert.equal(res.summary, '脚本执行遇到错误');
  assert.match(res.details, /command not found/);
});

test('parseActionError: 空日志或无文本时返回 null', () => {
  assert.equal(parseActionError(''), null);
  assert.equal(parseActionError(null), null);
});

test('cleanErrorLine: 清除常见错误前缀符号与标签', () => {
  assert.equal(cleanErrorLine('! [ERROR] some error occurred'), 'some error occurred');
  assert.equal(cleanErrorLine('ERROR: field price invalid'), 'field price invalid');
});
