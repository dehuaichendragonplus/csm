const { test } = require('node:test');
const assert = require('node:assert');
const { makeXlsx } = require('./helpers/make-xlsx');
const { readWorkbook } = require('../lib/xlsx-reader');
const { patchWorkbook } = require('../lib/xlsx-writer');

const base = () => makeXlsx({
  S: [['id', 'name', 'n'], ['number', 'string', 'number'], [1, 'a', 10], [2, 'b', 20]],
  Other: [['x'], [1]]
});
const rowsOf = (buf, name) => readWorkbook(buf).find(s => s.name === name).rows;

test('patchWorkbook：改单元格，其余工作表原样', () => {
  const { buffer } = patchWorkbook(base(), [{ name: 'S', rows: [
    { src: 1, v: ['id', 'name', 'n'] }, { src: 2, v: ['number', 'string', 'number'] },
    { src: 3, v: ['1', 'A & <x>', '10'] }, { src: 4, v: ['2', 'b', '25', '5,2,7'] }
  ] }]);
  assert.deepEqual(rowsOf(buffer, 'S'), [['id', 'name', 'n'], ['number', 'string', 'number'], ['1', 'A & <x>', '10'], ['2', 'b', '25', '5,2,7']]);
  assert.deepEqual(rowsOf(buffer, 'Other'), [['x'], ['1']]);
});

test('patchWorkbook：插入 / 删除行，行号重排', () => {
  const { buffer } = patchWorkbook(base(), [{ name: 'S', rows: [
    { src: 1, v: ['id', 'name', 'n'] }, { src: 2, v: ['number', 'string', 'number'] },
    { src: null, v: ['9', 'new', '90'] }, { src: 4, v: ['2', 'b', '20'] }
  ] }]);
  assert.deepEqual(rowsOf(buffer, 'S'), [['id', 'name', 'n'], ['number', 'string', 'number'], ['9', 'new', '90'], ['2', 'b', '20']]);
});

test('patchWorkbook：清空单元格、数字与前导 0 文本', () => {
  const { buffer } = patchWorkbook(base(), [{ name: 'S', rows: [
    { src: 1, v: ['id', '', 'n'] }, { src: 2, v: ['number', 'string', 'number'] }, { src: 3, v: ['1', '007', '1.5'] }
  ] }]);
  assert.deepEqual(rowsOf(buffer, 'S'), [['id', '', 'n'], ['number', 'string', 'number'], ['1', '007', '1.5']]);
});

test('patchWorkbook：有合并单元格时拒绝插入 / 删除行', () => {
  const { zip } = require('./helpers/make-xlsx');
  const sheet = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>b</t></is></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>';
  const buf = zip({
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="M" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet
  });
  assert.throws(() => patchWorkbook(buf, [{ name: 'M', rows: [{ src: 2, v: ['b'] }] }]), /合并单元格/);
  const ok = patchWorkbook(buf, [{ name: 'M', rows: [{ src: 1, v: ['a'] }, { src: 2, v: ['c'] }] }]);
  assert.deepEqual(rowsOf(ok.buffer, 'M'), [['a'], ['c']]);
});

test('patchWorkbook：改写 / 插入单元格沿用文本或数值类型', () => {
  const { zip } = require('./helpers/make-xlsx');
  const { readZip } = require('../lib/xlsx-reader');
  const sheet = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + '<row r="1"><c r="A1" t="inlineStr"><is><t>1</t></is></c><c r="B1"><v>5</v></c></row></sheetData></worksheet>';
  const buf = zip({
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="T" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet
  });
  const { buffer } = patchWorkbook(buf, [{ name: 'T', rows: [{ src: 1, v: ['13', '6'] }, { src: null, v: ['7', '8'] }] }]);
  const xml = readZip(buffer).read('xl/worksheets/sheet1.xml');
  assert.match(xml, /<c r="A1" t="inlineStr"><is><t xml:space="preserve">13<\/t>/);   // 原来是文本 → 仍是文本
  assert.match(xml, /<c r="B1"><v>6<\/v><\/c>/);                                       // 原来是数值 → 仍是数值
  assert.match(xml, /<c r="A2" t="inlineStr">/);                                        // 新行按上方同列推断
  assert.match(xml, /<c r="B2"><v>8<\/v><\/c>/);
});
