const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  extractImportSources, effectiveInfo, resolveCloudInfos, createSourceStore, memoryStore, needsProbe
} = require('../lib/mirror-sources');
const { getModifiedTimes, probeFormulas, PROBE_FIELDS } = require('../lib/drive-api');
const { aggregateTables } = require('../lib/table-aggregator');
const { uploadConflict } = require('../lib/status');
const { cloudMemoryKey, cloudExportFilename } = require('../lib/cloud-export-cache');

const MIRROR = 'mirrorSheet0000000000000000000001';
const SOURCE = 'sourceSheet0000000000000000000001';
const SOURCE2 = 'sourceSheet0000000000000000000002';

// 探测结果（PROBE_FIELDS 的形状）：formulas = [[row, col, formula]]
function probeSheets(...sheets) {
  return sheets.map((formulas, i) => ({
    properties: { sheetId: i, title: `S${i}` },
    data: [{ rowData: formulas.reduce((rows, [r, c, f]) => {
      while (rows.length <= r) rows.push({ values: [] });
      const vals = rows[r].values;
      while (vals.length <= c) vals.push({});
      vals[c] = { userEnteredValue: { formulaValue: f } };
      return rows;
    }, []) }]
  }));
}

const info = (modifiedTime, extra = {}) => ({ modifiedTime, name: extra.name || null, modifiedBy: extra.modifiedBy || null, error: null, ...extra });
const fail = error => ({ modifiedTime: null, name: null, modifiedBy: null, error });

// 假的批量查询：按 times 表返回，记录每次查了哪些 id
function fakeTimes(times) {
  const calls = [];
  const getTimes = async ids => {
    calls.push([...ids].sort());
    return new Map(ids.map(id => [id, times[id] || fail('not_found')]));
  };
  return { getTimes, calls };
}

// ---------- 识别源表 ----------
test('extractImportSources：完整 URL / 纯 id / 嵌套在其他函数里的 IMPORTRANGE 都能识别，去重排序', () => {
  const sheets = probeSheets(
    [[0, 0, `=IMPORTRANGE("https://docs.google.com/spreadsheets/d/${SOURCE}/edit#gid=0", "Main!A1:C")`],
      [0, 5, `=IMPORTRANGE("${SOURCE}", "Main!D1:D")`]],
    [[1, 0, `=IFERROR(QUERY(IMPORTRANGE("${SOURCE2}", "'Sheet 1'!A:B"), "select *"), "")`],
      [2, 0, '=SUM(A1:A9)']]
  );
  assert.deepStrictEqual(extractImportSources(sheets), { sources: [SOURCE, SOURCE2].sort(), unresolved: 0 });
});

test('extractImportSources：源表地址写成单元格引用的记为无法识别；引用自身不算源表；没有公式时为空', () => {
  const sheets = probeSheets([[0, 0, '=IMPORTRANGE(B1, "Main!A:A")'], [0, 1, `=IMPORTRANGE("${MIRROR}", "Other!A:A")`]]);
  assert.deepStrictEqual(extractImportSources(sheets, MIRROR), { sources: [], unresolved: 1 });
  assert.deepStrictEqual(extractImportSources(probeSheets([])), { sources: [], unresolved: 0 });
  assert.deepStrictEqual(extractImportSources(undefined), { sources: [], unresolved: 0 });
});

// ---------- 有效版本 ----------
test('effectiveInfo：源表比镜像表新 → 有效版本取源表时间，修改人取源表的，标出 changedVia', () => {
  const times = new Map([[SOURCE, info('2026-11-12T09:00:00.000Z', { name: '对照表', modifiedBy: '策划A' })]]);
  const eff = effectiveInfo(info('2026-11-01T00:00:00.000Z', { name: '镜像', modifiedBy: '程序B' }), { sources: [SOURCE] }, times);
  assert.strictEqual(eff.modifiedTime, '2026-11-12T09:00:00.000Z');
  assert.strictEqual(eff.ownModifiedTime, '2026-11-01T00:00:00.000Z');
  assert.strictEqual(eff.modifiedBy, '策划A');
  assert.strictEqual(eff.ownModifiedBy, '程序B');
  assert.strictEqual(eff.name, '镜像');
  assert.deepStrictEqual(eff.changedVia, { id: SOURCE, name: '对照表' });
  assert.strictEqual(eff.sourceCheck, 'ok');
  assert.strictEqual(eff.sourceWarning, null);
});

test('effectiveInfo：源表比镜像表旧 → 有效版本仍是镜像表自身时间', () => {
  const times = new Map([[SOURCE, info('2026-10-01T00:00:00.000Z')]]);
  const eff = effectiveInfo(info('2026-11-01T00:00:00.000Z', { modifiedBy: '程序B' }), { sources: [SOURCE] }, times);
  assert.strictEqual(eff.modifiedTime, '2026-11-01T00:00:00.000Z');
  assert.strictEqual(eff.modifiedBy, '程序B');
  assert.strictEqual(eff.changedVia, null);
});

test('effectiveInfo：源表没权限 / 查询失败 → 退回只用自身时间，并给出「无法检查源表更新」', () => {
  const own = info('2026-11-01T00:00:00.000Z');
  const forbidden = effectiveInfo(own, { sources: [SOURCE] }, new Map([[SOURCE, fail('forbidden')]]));
  assert.strictEqual(forbidden.modifiedTime, own.modifiedTime);
  assert.strictEqual(forbidden.sourceCheck, 'failed');
  assert.match(forbidden.sourceWarning, /^无法检查源表更新：没有源表的访问权限/);
  assert.strictEqual(forbidden.sources[0].error, 'forbidden');

  // 一张源表失败、另一张正常：正常的那张仍参与取 max，但照样提示
  const mixed = effectiveInfo(own, { sources: [SOURCE, SOURCE2] },
    new Map([[SOURCE, fail('rate_limited')], [SOURCE2, info('2026-11-05T00:00:00.000Z')]]));
  assert.strictEqual(mixed.modifiedTime, '2026-11-05T00:00:00.000Z');
  assert.strictEqual(mixed.sourceCheck, 'failed');

  // 源表地址无法识别
  const unresolved = effectiveInfo(own, { sources: [], unresolved: 2 }, new Map());
  assert.strictEqual(unresolved.modifiedTime, own.modifiedTime);
  assert.match(unresolved.sourceWarning, /2 个 IMPORTRANGE 的源表地址无法识别/);
});

test('effectiveInfo：普通表 / 镜像表自身查询失败时原样返回，不加任何字段', () => {
  const own = info('2026-11-01T00:00:00.000Z');
  assert.strictEqual(effectiveInfo(own, null, new Map()), own);
  assert.strictEqual(effectiveInfo(own, { sources: [], unresolved: 0 }, new Map()), own);
  const err = fail('forbidden');
  assert.strictEqual(effectiveInfo(err, { sources: [SOURCE] }, new Map([[SOURCE, info('2026-12-01T00:00:00.000Z')]])), err);
});

// ---------- 查询流程 ----------
test('resolveCloudInfos：首次探测发现源表并补查源表时间；之后源表和镜像表放在同一批查询，不再探测', async () => {
  const store = memoryStore();
  const times = {
    [MIRROR]: info('2026-11-01T00:00:00.000Z', { name: 'FF1_TRANSLATION' }),
    [SOURCE]: info('2026-11-12T09:00:00.000Z', { name: 'FF1-翻译文本对照表', modifiedBy: '策划A' }),
    plain: info('2026-11-02T00:00:00.000Z')
  };
  const { getTimes, calls } = fakeTimes(times);
  const probed = [];
  const probe = async id => {
    probed.push(id);
    return id === MIRROR ? probeSheets([[0, 0, `=IMPORTRANGE("${SOURCE}", "Main!A1:Z")`]]) : probeSheets([[0, 0, '=A1+1']]);
  };

  const first = await resolveCloudInfos([MIRROR, 'plain'], { getTimes, probe, store });
  assert.deepStrictEqual(probed.sort(), [MIRROR, 'plain'].sort());
  assert.deepStrictEqual(calls, [[MIRROR, 'plain'].sort(), [SOURCE]], '第一批只有表自身；新发现的源表补查一次');
  assert.strictEqual(first.get(MIRROR).modifiedTime, '2026-11-12T09:00:00.000Z');
  assert.deepStrictEqual(first.get('plain'), times.plain, '普通表原样返回');
  assert.deepStrictEqual(store.data[MIRROR].sources, [SOURCE]);
  assert.strictEqual(store.data[MIRROR].probedFor, '2026-11-01T00:00:00.000Z');
  assert.deepStrictEqual(store.data.plain.sources, []);

  calls.length = 0;
  probed.length = 0;
  const second = await resolveCloudInfos([MIRROR, 'plain'], { getTimes, probe, store });
  assert.deepStrictEqual(probed, [], '镜像表自身时间没变，不重新探测');
  assert.deepStrictEqual(calls, [[MIRROR, SOURCE, 'plain'].sort()], '源表和镜像表在同一批里查');
  assert.strictEqual(second.get(MIRROR).modifiedTime, '2026-11-12T09:00:00.000Z');
});

test('resolveCloudInfos：源表 id 真的进了 getModifiedTimes 的同一个 batch 请求', async () => {
  const store = memoryStore({ [MIRROR]: { probedFor: '2026-11-01T00:00:00.000Z', sources: [SOURCE], unresolved: 0 } });
  const bodies = [];
  const request = async opts => {
    bodies.push(opts.data);
    const ids = [...opts.data.matchAll(/GET \/drive\/v3\/files\/([^?]+)\?/g)].map(m => m[1]);
    const boundary = 'b';
    const text = ids.map((id, i) => [`--${boundary}`, 'Content-Type: application/http', `Content-ID: <response-item${i}>`, '',
      'HTTP/1.1 200 OK', 'Content-Type: application/json', '',
      JSON.stringify({ id, modifiedTime: id === SOURCE ? '2026-11-12T09:00:00.000Z' : '2026-11-01T00:00:00.000Z' }), ''].join('\r\n')).join('') + `--${boundary}--`;
    return { data: text, headers: { 'content-type': `multipart/mixed; boundary=${boundary}` } };
  };
  const m = await resolveCloudInfos([MIRROR], { getTimes: ids => getModifiedTimes(ids, null, { request }), probe: null, store });
  assert.strictEqual(bodies.length, 1);
  assert.match(bodies[0], new RegExp(`/files/${MIRROR}\\?`));
  assert.match(bodies[0], new RegExp(`/files/${SOURCE}\\?`));
  assert.strictEqual(m.get(MIRROR).modifiedTime, '2026-11-12T09:00:00.000Z');
});

test('resolveCloudInfos：镜像表自身时间变了才重新探测（可能改了公式、换了源表）', async () => {
  const store = memoryStore({ [MIRROR]: { probedFor: '2026-11-01T00:00:00.000Z', sources: [SOURCE], unresolved: 0 } });
  const times = {
    [MIRROR]: info('2026-11-10T00:00:00.000Z'),
    [SOURCE]: info('2026-11-02T00:00:00.000Z'),
    [SOURCE2]: info('2026-11-11T00:00:00.000Z')
  };
  const { getTimes } = fakeTimes(times);
  let probes = 0;
  const probe = async () => { probes++; return probeSheets([[0, 0, `=IMPORTRANGE("${SOURCE2}", "A:A")`]]); };
  const m = await resolveCloudInfos([MIRROR], { getTimes, probe, store });
  assert.strictEqual(probes, 1);
  assert.deepStrictEqual(store.data[MIRROR].sources, [SOURCE2]);
  assert.strictEqual(m.get(MIRROR).modifiedTime, '2026-11-11T00:00:00.000Z');
  assert.strictEqual(needsProbe(store.data[MIRROR], times[MIRROR]), false);
  assert.strictEqual(needsProbe(store.data[MIRROR], fail('forbidden')), false, '自身查询失败时不探测');
});

test('resolveCloudInfos：探测临时失败沿用旧记录、不落盘；永久性失败（非原生表格等）记下来不再反复探测', async () => {
  const store = memoryStore({ [MIRROR]: { probedFor: 'old', sources: [SOURCE], unresolved: 0 } });
  const times = { [MIRROR]: info('2026-11-10T00:00:00.000Z'), [SOURCE]: info('2026-11-12T00:00:00.000Z'), xlsxFile: info('2026-11-03T00:00:00.000Z') };
  const { getTimes } = fakeTimes(times);
  const probe = async id => {
    if (id === MIRROR) throw Object.assign(new Error('rate'), { code: 429 });
    throw Object.assign(new Error('This operation is not supported for this document'), { code: 400 });
  };
  const m = await resolveCloudInfos([MIRROR, 'xlsxFile'], { getTimes, probe, store });
  assert.strictEqual(store.data[MIRROR].probedFor, 'old', '临时失败不覆盖旧记录');
  assert.strictEqual(m.get(MIRROR).modifiedTime, '2026-11-12T00:00:00.000Z', '仍按旧记录里的源表算有效版本');
  assert.deepStrictEqual(store.data.xlsxFile, { probedFor: '2026-11-03T00:00:00.000Z', probedAt: store.data.xlsxFile.probedAt, sources: [], unresolved: 0, probeError: 'unsupported' });
  assert.deepStrictEqual(m.get('xlsxFile'), times.xlsxFile);
});

test('resolveCloudInfos：探测超过等待上限时先按旧记录返回，探测在后台完成后写入记录，下次生效', async () => {
  const store = memoryStore();
  const times = { [MIRROR]: info('2026-11-01T00:00:00.000Z'), [SOURCE]: info('2026-11-12T00:00:00.000Z') };
  const { getTimes } = fakeTimes(times);
  let release;
  const gate = new Promise(r => { release = r; });
  let probes = 0;
  const probe = async () => { probes++; await gate; return probeSheets([[0, 0, `=IMPORTRANGE("${SOURCE}", "A:A")`]]); };
  let saved = 0;
  store.save = () => { saved++; };
  let probedDone;
  const done = new Promise(r => { probedDone = r; });

  const first = await resolveCloudInfos([MIRROR], { getTimes, probe, store, budgetMs: 20, onProbed: probedDone });
  assert.strictEqual(first.get(MIRROR).modifiedTime, '2026-11-01T00:00:00.000Z', '还不知道是镜像表：先按普通表');
  // 探测还在后台跑时再刷新：复用同一个探测，不重复请求
  const again = await resolveCloudInfos([MIRROR], { getTimes, probe, store, budgetMs: 20 });
  assert.strictEqual(again.get(MIRROR).modifiedTime, '2026-11-01T00:00:00.000Z');
  assert.strictEqual(probes, 1);

  release();
  await done;
  assert.ok(saved >= 1, '后台探测完成后落盘');
  const next = await resolveCloudInfos([MIRROR], { getTimes, probe, store, budgetMs: 20 });
  assert.strictEqual(next.get(MIRROR).modifiedTime, '2026-11-12T00:00:00.000Z');
  assert.strictEqual(probes, 1);
});

test('resolveCloudInfos：源表没有权限 → 有效版本退回镜像表自身时间，并带上提示', async () => {
  const store = memoryStore({ [MIRROR]: { probedFor: '2026-11-01T00:00:00.000Z', sources: [SOURCE], unresolved: 0 } });
  const { getTimes } = fakeTimes({ [MIRROR]: info('2026-11-01T00:00:00.000Z'), [SOURCE]: fail('forbidden') });
  const m = await resolveCloudInfos([MIRROR], { getTimes, probe: async () => { throw new Error('不应探测'); }, store });
  assert.strictEqual(m.get(MIRROR).modifiedTime, '2026-11-01T00:00:00.000Z');
  assert.strictEqual(m.get(MIRROR).sourceCheck, 'failed');
  assert.match(m.get(MIRROR).sourceWarning, /无法检查源表更新/);
});

test('createSourceStore：落盘后重新加载仍在；文件损坏时当作空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-mirror-'));
  const file = path.join(dir, 'cache', 'mirror-sources.json');
  const a = createSourceStore(file);
  assert.strictEqual(a.get(MIRROR), null);
  a.set(MIRROR, { probedFor: 't', sources: [SOURCE], unresolved: 0 });
  a.save();
  assert.deepStrictEqual(createSourceStore(file).get(MIRROR).sources, [SOURCE]);
  fs.writeFileSync(file, '{oops');
  assert.strictEqual(createSourceStore(file).get(MIRROR), null);
});

// ---------- 用到有效版本的地方 ----------
function tmpTable() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-mirror-agg-'));
  const savePath = path.join(dir, 'I18n.xlsx');
  fs.writeFileSync(savePath, 'xlsx-bytes');
  const st = fs.statSync(savePath);
  return { savePath, st };
}

test('状态判断：只有源表被改过（镜像表自身时间没变）也显示「云端有更新」；源表查不到时退回原判断并带提示', async () => {
  const { savePath, st } = tmpTable();
  const entry = { path: 'Datas/I18n.xlsx', name: 'I18n', spreadsheetId: MIRROR, savePath };
  const state = { [entry.path]: { lastSyncedModifiedTime: '2026-11-01T00:00:00.000Z', lastSyncedSize: st.size, lastSyncedMtime: st.mtime.toISOString() } };
  const store = memoryStore({ [MIRROR]: { probedFor: '2026-11-01T00:00:00.000Z', sources: [SOURCE], unresolved: 0 } });

  // 修复前：只看镜像表自身时间 → 已同步
  const [before] = aggregateTables([entry], new Map([[MIRROR, info('2026-11-01T00:00:00.000Z')]]), state);
  assert.strictEqual(before.status, 'synced');

  const { getTimes } = fakeTimes({ [MIRROR]: info('2026-11-01T00:00:00.000Z'), [SOURCE]: info('2026-11-12T09:00:00.000Z', { name: '对照表', modifiedBy: '策划A' }) });
  const [row] = aggregateTables([entry], await resolveCloudInfos([MIRROR], { getTimes, store }), state);
  assert.strictEqual(row.status, 'updated');
  assert.strictEqual(row.direction, 'download');
  assert.strictEqual(row.cloudModifiedTime, '2026-11-12T09:00:00.000Z');
  assert.strictEqual(row.cloudOwnModifiedTime, '2026-11-01T00:00:00.000Z');
  assert.strictEqual(row.cloudModifiedBy, '策划A');
  assert.deepStrictEqual(row.cloudChangedVia, { id: SOURCE, name: '对照表' });
  assert.strictEqual(row.sourceWarning, null);

  const denied = fakeTimes({ [MIRROR]: info('2026-11-01T00:00:00.000Z'), [SOURCE]: fail('forbidden') });
  const [row2] = aggregateTables([entry], await resolveCloudInfos([MIRROR], { getTimes: denied.getTimes, store }), state);
  assert.strictEqual(row2.status, 'synced');
  assert.match(row2.sourceWarning, /无法检查源表更新/);
});

test('导出缓存键 / 核对键：源表改了，有效版本变了，键随之改变，不会再命中旧导出', async () => {
  const store = memoryStore({ [MIRROR]: { probedFor: '2026-11-01T00:00:00.000Z', sources: [SOURCE], unresolved: 0 } });
  const v1 = (await resolveCloudInfos([MIRROR], { getTimes: fakeTimes({ [MIRROR]: info('2026-11-01T00:00:00.000Z'), [SOURCE]: info('2026-10-01T00:00:00.000Z') }).getTimes, store })).get(MIRROR);
  const v2 = (await resolveCloudInfos([MIRROR], { getTimes: fakeTimes({ [MIRROR]: info('2026-11-01T00:00:00.000Z'), [SOURCE]: info('2026-11-12T00:00:00.000Z') }).getTimes, store })).get(MIRROR);
  assert.strictEqual(v1.ownModifiedTime, v2.ownModifiedTime);
  assert.notStrictEqual(cloudMemoryKey(MIRROR, v1.modifiedTime), cloudMemoryKey(MIRROR, v2.modifiedTime));
  assert.notStrictEqual(cloudExportFilename(MIRROR, v1.modifiedTime), cloudExportFilename(MIRROR, v2.modifiedTime));
});

test('上传冲突检测：确认上传后有人只改了源表，用有效版本比较能拦下来', async () => {
  const store = memoryStore({ [MIRROR]: { probedFor: '2026-11-01T00:00:00.000Z', sources: [SOURCE], unresolved: 0 } });
  const seen = (await resolveCloudInfos([MIRROR], { getTimes: fakeTimes({ [MIRROR]: info('2026-11-01T00:00:00.000Z'), [SOURCE]: info('2026-11-05T00:00:00.000Z') }).getTimes, store })).get(MIRROR);
  const now = (await resolveCloudInfos([MIRROR], { getTimes: fakeTimes({ [MIRROR]: info('2026-11-01T00:00:00.000Z'), [SOURCE]: info('2026-11-12T00:00:00.000Z') }).getTimes, store })).get(MIRROR);
  // 只看镜像表自身时间：看不出来
  assert.strictEqual(uploadConflict({ cloudModifiedTime: now.ownModifiedTime, expect: seen.ownModifiedTime }), null);
  // 有效版本：冲突
  assert.deepStrictEqual(uploadConflict({ cloudModifiedTime: now.modifiedTime, expect: seen.modifiedTime }), { baseline: seen.modifiedTime });
  assert.strictEqual(uploadConflict({ cloudModifiedTime: now.modifiedTime, expect: seen.modifiedTime, force: true }), null);
});

test('probeFormulas：只拉公式字段（PROBE_FIELDS），返回 sheets 数组', async () => {
  const calls = [];
  const sheetsClient = { spreadsheets: { get: async (params, opts) => { calls.push({ params, opts }); return { data: { sheets: probeSheets([[0, 0, '=1']]) } }; } } };
  const sheets = await probeFormulas(MIRROR, null, { sheetsClient });
  assert.strictEqual(sheets.length, 1);
  assert.strictEqual(calls[0].params.spreadsheetId, MIRROR);
  assert.strictEqual(calls[0].params.fields, PROBE_FIELDS);
  assert.strictEqual(calls[0].params.includeGridData, true);
  assert.ok(calls[0].opts.timeout > 0);
});
