const { test } = require('node:test');
const assert = require('node:assert');
const { makeXlsx, zip } = require('./helpers/make-xlsx');
const { readWorkbook, colName, colIndex, normalizeNumber, decodeXml } = require('../lib/xlsx-reader');
const { diffWorkbooks, alignRows, alignedEntries, buildView, sameCell } = require('../lib/xlsx-diff');

test('readWorkbook：按工作表顺序读出共享字符串、数字、布尔，去掉尾部空行空列', () => {
  const buf = makeXlsx({
    Item: [['##var', 'id', 'name'], ['', 1, 'Apple & <Pear>'], ['', 2.5, true], ['', '', '']],
    第二页: [['a']]
  });
  const wb = readWorkbook(buf);
  assert.deepStrictEqual(wb.map(s => s.name), ['Item', '第二页']);
  assert.deepStrictEqual(wb[0].rows, [['##var', 'id', 'name'], ['', '1', 'Apple & <Pear>'], ['', '2.5', 'TRUE']]);
  assert.deepStrictEqual(wb[1].rows, [['a']]);
});

test('readWorkbook：富文本拼接、跳过注音、inlineStr、公式取缓存值、缺 r 属性的单元格按顺序排', () => {
  const files = {
    'xl/workbook.xml': '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="/xl/worksheets/s.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><r><t>Hel</t></r><r><t>lo</t></r><rPh><t>ハ</t></rPh></si></sst>',
    'xl/worksheets/s.xml': '<worksheet><sheetData><row r="2"><c t="s"><v>0</v></c><c t="inlineStr"><is><t>in&#x4E2D;</t></is></c><c><f>1+1</f><v>2</v></c><c t="str"><f>A1</f><v>x_x000D_y</v></c></row></sheetData></worksheet>'
  };
  const wb = readWorkbook(zip(files));
  assert.deepStrictEqual(wb[0].rows, [[], ['Hello', 'in中', '2', 'x\ry']]);
});

test('readWorkbook：不是 zip 时报清楚的错误', () => {
  assert.throws(() => readWorkbook(Buffer.from('not a zip at all, definitely not')), /不是有效的 xlsx/);
});

test('列名换算与数字规范化', () => {
  assert.strictEqual(colName(0), 'A');
  assert.strictEqual(colName(25), 'Z');
  assert.strictEqual(colName(26), 'AA');
  assert.strictEqual(colIndex('AB'), 27);
  assert.strictEqual(normalizeNumber('0.10000000000000001'), '0.1');
  assert.strictEqual(normalizeNumber('1.0'), '1');
  assert.strictEqual(decodeXml('&lt;a&gt; &amp; &quot;&apos;'), '<a> & "\'');
  assert.ok(sameCell('0.30000000000000004', '0.3'));
  assert.ok(!sameCell('1', '2'));
  assert.ok(!sameCell('', '0'));
});

test('diffWorkbooks：完全相同 → identical', () => {
  const a = readWorkbook(makeXlsx({ S: [['id', 'v'], [1, 'a']] }));
  const b = readWorkbook(makeXlsx({ S: [['id', 'v'], [1, 'a']] }));
  const d = diffWorkbooks(a, b);
  assert.strictEqual(d.identical, true);
  assert.strictEqual(d.sheets[0].status, 'same');
});

test('diffWorkbooks：中间插入一行不会让后面所有行都算作修改', () => {
  const rows = Array.from({ length: 50 }, (_, i) => [i, `name${i}`, i * 10]);
  const local = [{ name: 'S', rows: rows.map(r => r.map(String)) }];
  const cloudRows = rows.map(r => r.map(String));
  cloudRows.splice(10, 0, ['new', 'inserted', '0']);  // 云端第 11 行新增
  cloudRows[30][2] = 'changed';                        // 云端第 31 行（本地第 30 行）改一格
  cloudRows.splice(40, 1);                             // 删除云端第 41 行（本地第 40 行）
  const d = diffWorkbooks(local, [{ name: 'S', rows: cloudRows }]);
  const s = d.sheets[0];
  assert.strictEqual(s.status, 'changed');
  assert.deepStrictEqual(s.stats, { modified: 1, localOnly: 1, cloudOnly: 1, cells: 1 });
  const mod = s.changes.find(c => c.type === 'modified');
  assert.strictEqual(mod.localRow, 30);
  assert.strictEqual(mod.cloudRow, 31);
  assert.deepStrictEqual(mod.cells, [{ col: 2, colName: 'C', local: '290', cloud: 'changed' }]);
  assert.strictEqual(s.changes.find(c => c.type === 'cloud_only').cloudRow, 11);
  assert.strictEqual(s.changes.find(c => c.type === 'local_only').localRow, 40);
});

test('diffWorkbooks：工作表增删、Luban 表头作为列名、改动数量截断', () => {
  const local = [{ name: 'A', rows: [['##var', 'id', 'name'], ['', '1', 'x'], ['', '2', 'y']] }, { name: 'OnlyLocal', rows: [['x']] }];
  const cloud = [{ name: 'A', rows: [['##var', 'id', 'name'], ['', '1', 'X'], ['', '2', 'Y']] }, { name: 'OnlyCloud', rows: [['y']] }];
  const d = diffWorkbooks(local, cloud, { maxChanges: 1 });
  assert.deepStrictEqual(d.sheets.map(s => [s.name, s.status]), [['A', 'changed'], ['OnlyLocal', 'local_only'], ['OnlyCloud', 'cloud_only']]);
  assert.deepStrictEqual(d.sheets[0].header, ['##var', 'id', 'name']);
  assert.strictEqual(d.sheets[0].changes.length, 1);
  assert.strictEqual(d.sheets[0].truncated, true);
  assert.strictEqual(d.sheets[0].stats.modified, 2);
});

test('alignRows：数字的浮点尾数差异不影响相同行判断以外的配对', () => {
  const ops = alignRows([['a'], ['b'], ['c']], [['a'], ['c']]);
  assert.deepStrictEqual(ops.map(o => o.op), ['same', 'local', 'same']);
});

test('view：小表带上全部相同行，修改行标出改动列，本地 / 云端行号各自独立', () => {
  const local = [{ name: 'S', rows: [['id', 'v'], ['1', 'a'], ['2', 'b'], ['3', 'c']] }];
  const cloud = [{ name: 'S', rows: [['id', 'v'], ['1', 'a'], ['new', 'x'], ['2', 'B'], ['3', 'c']] }];
  const v = diffWorkbooks(local, cloud).sheets[0].view;
  assert.strictEqual(v.full, true);
  assert.strictEqual(v.cols, 2);
  assert.deepStrictEqual(v.rows.map(r => [r.k, r.l, r.c]), [['=', 1, 1], ['=', 2, 2], ['C', undefined, 3], ['~', 3, 4], ['=', 4, 5]]);
  const mod = v.rows.find(r => r.k === '~');
  assert.deepStrictEqual([mod.lv, mod.cv, mod.d], [['2', 'b'], ['2', 'B'], [1]]);
});

test('view：大表只保留改动前后的上下文，其余相同行折叠成 gap；改动太多时截断', () => {
  const L = Array.from({ length: 100 }, (_, i) => [String(i)]);
  const C = L.map(r => r.slice());
  C[50] = ['x'];
  const entries = alignedEntries(L, C, alignRows(L, C));
  const v = buildView(L, C, entries, { full: false, context: 2 });
  assert.deepStrictEqual(v.rows.map(r => r.k), ['gap', '=', '=', '~', '=', '=', 'gap']);
  assert.deepStrictEqual([v.rows[0].n, v.rows[0].l, v.rows[0].c], [48, 1, 1]);
  assert.deepStrictEqual([v.rows[6].n, v.rows[6].l], [47, 54]);
  const many = L.map(() => ['y']);
  const t = buildView(L, many, alignedEntries(L, many, alignRows(L, many)), { maxChanges: 10 });
  assert.strictEqual(t.truncated, true);
  assert.strictEqual(t.rows.filter(r => r.k !== '=').length, 10);
});

test('view：只在一边的工作表，全部行作为新增 / 删除展示', () => {
  const d = diffWorkbooks([{ name: 'A', rows: [['a'], ['b']] }], []);
  assert.deepStrictEqual(d.sheets[0].view.rows.map(r => [r.k, r.l]), [['L', 1], ['L', 2]]);
});
