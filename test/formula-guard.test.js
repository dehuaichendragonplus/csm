const { test } = require('node:test');
const assert = require('node:assert');
const guard = require('../lib/formula-guard');
const { uploadXlsxPreservingFormulas } = require('../lib/drive-api');
const { makeXlsx } = require('./helpers/make-xlsx');

const IMPORT_A = '=IMPORTRANGE("https://docs.google.com/spreadsheets/d/xxx/edit", "Main!A2:A9000")';
const IMPORT_B = '=IMPORTRANGE("https://docs.google.com/spreadsheets/d/xxx/edit", "Main!R2:R9000")';
const s = v => ({ effectiveValue: { stringValue: v }, userEnteredValue: { stringValue: v } });
const spilled = v => ({ effectiveValue: { stringValue: v } });  // 公式溢出的格：只有有效值，没有用户输入

// 云端 Locale_TH：第 4 行（下标 3）起 A/B 两列是 IMPORTRANGE 溢出
function cloudSheet() {
  return {
    properties: { sheetId: 7, title: 'Locale_TH', gridProperties: { rowCount: 9003, columnCount: 2 } },
    data: [{ rowData: [
      { values: [s('key'), s('value')] },
      { values: [s('STRING'), s('STRING')] },
      { values: [s('#'), s('#')] },
      { values: [{ userEnteredValue: { formulaValue: IMPORT_A }, effectiveValue: { stringValue: 'k1' } }, { userEnteredValue: { formulaValue: IMPORT_B }, effectiveValue: { stringValue: 'v1' } }] },
      { values: [spilled('k2'), spilled('v2')] }
    ] }]
  };
}

test('findFormulas / protectedRegions：IMPORTRANGE 保护 A、B 两整列（第 4 行起）', () => {
  const sh = cloudSheet();
  assert.strictEqual(guard.findFormulas(sh).length, 2);
  const regions = guard.protectedRegions(sh);
  assert.deepStrictEqual(regions.map(r => [r.row, r.col, r.width, r.spill]), [[3, 0, 1, true], [3, 1, 1, true]]);
  assert.ok(guard.isProtected(regions, 3000, 0));
  assert.ok(!guard.isProtected(regions, 2, 0), '公式上方的表头不保护');
});

test('planSheet：公式区的差异只跳过不写，非公式区的差异正常写', () => {
  const local = [['key', 'value'], ['STRING', 'STRING'], ['#', 'CHANGED'], ['k1', 'v1'], ['k2', 'v2'], ['新key', '新值']];
  const plan = guard.planSheet(local, cloudSheet());
  assert.deepStrictEqual(plan.writes, [{ row: 2, col: 1, value: 'CHANGED' }]);
  assert.strictEqual(plan.skipped.count, 2);
  assert.deepStrictEqual(plan.skipped.samples.map(x => x.cell), ['A6', 'B6']);
});

test('planSheet：没有公式的表，本地与云端的所有差异都写入（含清空）', () => {
  const cloud = { properties: { sheetId: 1, title: 'T' }, data: [{ rowData: [{ values: [s('a'), s('b')] }] }] };
  const plan = guard.planSheet([['a', 'x', 'y']], cloud);
  assert.deepStrictEqual(plan.writes, [{ row: 0, col: 1, value: 'x' }, { row: 0, col: 2, value: 'y' }]);
  assert.strictEqual(plan.skipped.count, 0);
  assert.deepStrictEqual(guard.planSheet([['a']], cloud).writes, [{ row: 0, col: 1, value: '' }]);
});

test('planSheet：非溢出的单格公式只保护它自己', () => {
  const cloud = { properties: { sheetId: 1, title: 'T' }, data: [{ rowData: [
    { values: [{ userEnteredValue: { formulaValue: '=SUM(B1:B2)' }, effectiveValue: { numberValue: 3 } }, s('x')] },
    { values: [s('keep'), s('y')] }
  ] }] };
  const plan = guard.planSheet([['9', 'x'], ['changed', 'y']], cloud);
  assert.deepStrictEqual(plan.writes, [{ row: 1, col: 0, value: 'changed' }]);
  assert.strictEqual(plan.skipped.count, 1);
});

test('toValueRanges：同一行连续列合并；表名里的引号转义；= 开头加撇号', () => {
  const r = guard.toValueRanges("It's", [{ row: 0, col: 0, value: 'a' }, { row: 0, col: 1, value: '=1+1' }, { row: 0, col: 3, value: 'c' }]);
  assert.deepStrictEqual(r, [
    { range: "'It''s'!A1:B1", values: [['a', "'=1+1"]] },
    { range: "'It''s'!D1:D1", values: [['c']] }
  ]);
});

function fakeSheets({ probe, grid }) {
  const calls = { batchUpdate: [], valuesBatchUpdate: [] };
  return {
    calls,
    spreadsheets: {
      get: async ({ fields }) => ({ data: fields.includes('effectiveValue') ? grid : probe }),
      batchUpdate: async req => { calls.batchUpdate.push(req); return {}; },
      values: { batchUpdate: async req => { calls.valuesBatchUpdate.push(req); return {}; } }
    }
  };
}

test('uploadXlsxPreservingFormulas：云端没有公式 → 走原来的整表替换', async () => {
  const noFormula = { sheets: [{ properties: { sheetId: 1, title: 'T' }, data: [{ rowData: [{ values: [{}] }] }] }] };
  const sheets = fakeSheets({ probe: noFormula, grid: noFormula });
  let replaced = 0;
  const r = await uploadXlsxPreservingFormulas('id', Buffer.alloc(0), null, { sheetsClient: sheets, uploadReplace: async () => { replaced++; return { modifiedTime: 't', name: 'n' }; } });
  assert.strictEqual(replaced, 1);
  assert.strictEqual(r.formulaProtected, false);
  assert.strictEqual(sheets.calls.valuesBatchUpdate.length, 0);
});

const SRC = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const IMP = col => `=IMPORTRANGE("https://docs.google.com/spreadsheets/d/${SRC}/edit?gid=1#gid=1", "Main!${col}2:${col}9000")`;

// 镜像表：Locale_TH（A←Main!A，B←Main!R）、Locale_EN（A←Main!A，B←Main!D）
function mirrorSheet(title, sheetId, col, rows) {
  return {
    properties: { sheetId, title, gridProperties: { rowCount: 9003, columnCount: 2 } },
    data: [{ rowData: [
      { values: [s('key'), s('value')] }, { values: [s('STRING'), s('STRING')] }, { values: [s('#'), s('#')] },
      { values: [{ userEnteredValue: { formulaValue: IMP('A') }, effectiveValue: { stringValue: rows[0][0] } }, { userEnteredValue: { formulaValue: IMP(col) }, effectiveValue: { stringValue: rows[0][1] } }] },
      ...rows.slice(1).map(r => ({ values: [spilled(r[0]), spilled(r[1])] }))
    ] }]
  };
}
// 源表 Main：第 1 行表头，第 2 行起数据；A=key，D=en，R=th
function mainSheet(rows) {
  const width = 18;
  const row = vals => ({ values: Array.from({ length: width }, (_, i) => (vals[i] != null ? s(vals[i]) : {})) });
  return { properties: { sheetId: 0, title: 'Main', gridProperties: { rowCount: 3, columnCount: 20 } }, data: [{ rowData: rows.map(row) }] };
}

test('parseImportRange：URL / 纯 id / 带引号的表名', () => {
  assert.deepStrictEqual(guard.parseImportRange(IMP('R')), { sourceId: SRC, sheet: 'Main', startRow: 1, startCol: 17, endRow: 8999, endCol: 17 });
  assert.deepStrictEqual(guard.parseImportRange(`=IMPORTRANGE("${SRC}", "'My ''S'!B:C")`), { sourceId: SRC, sheet: "My 'S", startRow: 0, startCol: 1, endRow: null, endCol: 2 });
  assert.strictEqual(guard.parseImportRange('=VLOOKUP(A4,Locale_TH!A:B,2,false)'), null);
});

test('planWriteThrough：镜像区差异映射到源表；多张镜像写同一个 key 列合并；值不同算冲突', () => {
  const th = mirrorSheet('Locale_TH', 1, 'R', [['k1', 'ไทย']]);
  const en = mirrorSheet('Locale_EN', 2, 'D', [['k1', 'one']]);
  const plan = guard.planWorkbook([
    { name: 'Locale_TH', rows: [['key', 'value'], ['STRING', 'STRING'], ['#', '#'], ['k1', 'ไทย2'], ['new', 'ใหม่']] },
    { name: 'Locale_EN', rows: [['key', 'value'], ['STRING', 'STRING'], ['#', '#'], ['k1', 'one'], ['new', 'New']] }
  ], [th, en]);
  const wt = guard.planWriteThrough(plan.plans);
  const cells = wt.sources.get(SRC).get('Main');
  // Main 第 2 行（下标 1）= 镜像第 4 行（下标 3）
  assert.deepStrictEqual([...cells.values()].map(c => [c.row, c.col, c.value]).sort(), [[1, 17, 'ไทย2'], [2, 0, 'new'], [2, 17, 'ใหม่'], [2, 3, 'New']].sort());
  assert.deepStrictEqual(cells.get('2,0').from, ['Locale_TH!A5', 'Locale_EN!A5']);
  assert.strictEqual(wt.blocked.length, 0);

  const conflict = guard.planWriteThrough(guard.planWorkbook([
    { name: 'Locale_TH', rows: [['key'], ['STRING'], ['#'], ['k1'], ['aaa']] },
    { name: 'Locale_EN', rows: [['key'], ['STRING'], ['#'], ['k1'], ['bbb']] }
  ], [mirrorSheet('Locale_TH', 1, 'R', [['k1', 'x']]), mirrorSheet('Locale_EN', 2, 'D', [['k1', 'y']])]).plans);
  assert.ok(!conflict.sources.get(SRC).get('Main').has('2,0'), '冲突的源格不写');
  assert.ok(conflict.blocked.some(b => b.reason === 'conflict'));
});

test('planWriteThrough：VLOOKUP 等单格公式算出来的格归为 derived，不写', () => {
  const loading = { properties: { sheetId: 3, title: 'Locale_Loading_TH' }, data: [{ rowData: [
    { values: [s('key'), s('value')] },
    { values: [s('UI_loading'), { userEnteredValue: { formulaValue: '=VLOOKUP(A2,Locale_TH!A:B,2,false)' }, effectiveValue: { stringValue: 'old' } }] }
  ] }] };
  const wt = guard.planWriteThrough(guard.planWorkbook([{ name: 'Locale_Loading_TH', rows: [['key', 'value'], ['UI_loading', 'new']] }], [loading]).plans);
  assert.strictEqual(wt.sources.size, 0);
  assert.deepStrictEqual(wt.derived.map(x => x.cell), ['B2']);
});

function fakeSheetsMulti(books) {
  const calls = { batchUpdate: [], values: [] };
  return {
    calls,
    spreadsheets: {
      get: async ({ spreadsheetId }) => ({ data: books[spreadsheetId] }),
      batchUpdate: async req => { calls.batchUpdate.push(req); return {}; },
      values: { batchUpdate: async req => { calls.values.push(req); return {}; } }
    }
  };
}

async function withFakeDrive(fn) {
  const { google } = require('googleapis');
  const orig = google.drive;
  google.drive = () => ({ files: { get: async ({ fileId }) => ({ data: { modifiedTime: 'T1', name: fileId === SRC ? '主翻译表' : '镜像表' } }) } });
  try { return await fn(); } finally { google.drive = orig; }
}

test('uploadXlsxPreservingFormulas：要改源表时，未确认只返回预览、一个格都不写；确认后写源表并扩行', async () => {
  const local = makeXlsx({ Locale_TH: [['key', 'value'], ['STRING', 'STRING'], ['#', '#'], ['k1', 'ไทย'], ['new', 'ใหม่']] });
  const books = {
    MIRROR: { sheets: [mirrorSheet('Locale_TH', 1, 'R', [['k1', 'ไทย']])] },
    [SRC]: { sheets: [mainSheet([['key'], ['k1', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'ไทย']])] }
  };
  await withFakeDrive(async () => {
    const sheets = fakeSheetsMulti(books);
    let replaced = 0;
    const preview = await uploadXlsxPreservingFormulas('MIRROR', local, {}, { sheetsClient: sheets, uploadReplace: async () => { replaced++; } });
    assert.strictEqual(replaced, 0, '有公式时绝不能整表替换');
    assert.strictEqual(preview.needsWriteThrough, true);
    assert.strictEqual(preview.sourceWriteCount, 2);
    assert.strictEqual(preview.sources[0].name, '主翻译表');
    assert.strictEqual(sheets.calls.values.length + sheets.calls.batchUpdate.length, 0, '未确认前不写');

    const done = await uploadXlsxPreservingFormulas('MIRROR', local, {}, { sheetsClient: sheets, writeThrough: true });
    assert.ok(!done.needsWriteThrough);
    assert.strictEqual(done.blockedCount, 0);
    const srcWrite = sheets.calls.values.find(c => c.spreadsheetId === SRC);
    assert.deepStrictEqual(srcWrite.requestBody.data, [{ range: "'Main'!A3:A3", values: [['new']] }, { range: "'Main'!R3:R3", values: [['ใหม่']] }]);
    // 源表只有 2 行数据 + rowCount 3：写第 3 行不需要扩；把 rowCount 调小验证扩行
  });

  books[SRC].sheets[0].properties.gridProperties.rowCount = 2;
  await withFakeDrive(async () => {
    const sheets = fakeSheetsMulti(books);
    await uploadXlsxPreservingFormulas('MIRROR', local, {}, { sheetsClient: sheets, writeThrough: true });
    assert.deepStrictEqual(sheets.calls.batchUpdate.find(c => c.spreadsheetId === SRC).requestBody.requests, [{ appendDimension: { sheetId: 0, dimension: 'ROWS', length: 1 } }]);
  });
});

test('uploadXlsxPreservingFormulas：源表那格已被别人改过 / 本身是公式 → 不写，记为 blocked', async () => {
  const local = makeXlsx({ Locale_TH: [['key', 'value'], ['STRING', 'STRING'], ['#', '#'], ['k1', 'mine']] });
  const main = mainSheet([['key'], ['k1']]);
  main.data[0].rowData[1].values[17] = s('someone-else');  // 源表已是新值，镜像还显示旧值
  const books = { MIRROR: { sheets: [mirrorSheet('Locale_TH', 1, 'R', [['k1', 'old']])] }, [SRC]: { sheets: [main] } };
  await withFakeDrive(async () => {
    const sheets = fakeSheetsMulti(books);
    const r = await uploadXlsxPreservingFormulas('MIRROR', local, {}, { sheetsClient: sheets, writeThrough: true });
    assert.strictEqual(r.sourceWriteCount, 0);
    assert.strictEqual(r.blockedCount, 1);
    assert.strictEqual(r.blockedSamples[0].reason, 'source_changed');
    assert.ok(!sheets.calls.values.some(c => c.spreadsheetId === SRC));
  });
});

test('planWriteThrough：镜像公式报错（#REF!，如 IMPORTRANGE 未授权）→ 整个区域拒绝写回', () => {
  const sh = mirrorSheet('Locale_TH', 1, 'R', [['k1', 'x']]);
  sh.data[0].rowData[3].values[0].effectiveValue = { errorValue: { type: 'REF', message: '需要授权' } };
  sh.data[0].rowData[4] = { values: [{}, spilled('x2')] };
  const wt = guard.planWriteThrough(guard.planWorkbook([{ name: 'Locale_TH', rows: [['key', 'value'], ['STRING', 'STRING'], ['#', '#'], ['k1', 'x'], ['new', 'y']] }], [sh]).plans);
  assert.ok(!wt.sources.get(SRC) || !wt.sources.get(SRC).get('Main').has('2,0'), 'A 列（报错的公式）不写回');
  assert.ok(wt.blocked.every(b => b.reason === 'mirror_error'));
  assert.ok(wt.blocked.length >= 2);
});
