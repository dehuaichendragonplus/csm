const { test } = require('node:test');
const assert = require('node:assert');
const { determineStatus } = require('../lib/status');

test('returns "error" when spreadsheetId is missing', () => {
  assert.strictEqual(determineStatus({ spreadsheetId: '', cloudModifiedTime: null, lastSyncedModifiedTime: null, localExists: false, apiError: null }), 'error');
});

test('returns "error" when Drive API call failed', () => {
  assert.strictEqual(determineStatus({ spreadsheetId: 'abc', cloudModifiedTime: null, lastSyncedModifiedTime: null, localExists: false, apiError: 'forbidden' }), 'error');
});

test('returns "missing_local" when local xlsx does not exist', () => {
  assert.strictEqual(determineStatus({ spreadsheetId: 'abc', cloudModifiedTime: '2026-05-20T08:15:22.000Z', lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z', localExists: false, apiError: null }), 'missing_local');
});

test('returns "never_synced" when sync state has no record', () => {
  assert.strictEqual(determineStatus({ spreadsheetId: 'abc', cloudModifiedTime: '2026-05-20T08:15:22.000Z', lastSyncedModifiedTime: null, localExists: true, apiError: null }), 'never_synced');
});

test('returns "updated" when cloud time is newer than last synced', () => {
  assert.strictEqual(determineStatus({ spreadsheetId: 'abc', cloudModifiedTime: '2026-05-27T14:30:00.000Z', lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z', localExists: true, apiError: null }), 'updated');
});

test('returns "synced" when cloud time matches last synced', () => {
  assert.strictEqual(determineStatus({ spreadsheetId: 'abc', cloudModifiedTime: '2026-05-20T08:15:22.000Z', lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z', localExists: true, apiError: null }), 'synced');
});

test('error takes precedence over missing_local', () => {
  assert.strictEqual(determineStatus({ spreadsheetId: '', cloudModifiedTime: null, lastSyncedModifiedTime: null, localExists: false, apiError: null }), 'error');
});

test('missing_local takes precedence over updated', () => {
  assert.strictEqual(determineStatus({ spreadsheetId: 'abc', cloudModifiedTime: '2026-05-27T14:30:00.000Z', lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z', localExists: false, apiError: null }), 'missing_local');
});

test('returns "local_changed" when local file diverges from sync record', () => {
  assert.strictEqual(determineStatus({ spreadsheetId: 'abc', cloudModifiedTime: '2026-05-20T08:15:22.000Z', lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z', localExists: true, apiError: null, localChanged: true }), 'local_changed');
});

test('cloud and local both changed → conflict (never auto-pick a direction)', () => {
  assert.strictEqual(determineStatus({ spreadsheetId: 'abc', cloudModifiedTime: '2026-05-27T14:30:00.000Z', lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z', localExists: true, apiError: null, localChanged: true }), 'conflict');
});

test('cloud changed and local untouched → updated', () => {
  assert.strictEqual(determineStatus({ spreadsheetId: 'abc', cloudModifiedTime: '2026-05-27T14:30:00.000Z', lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z', localExists: true, apiError: null, localChanged: false }), 'updated');
});

test('missing_local takes precedence over local_changed', () => {
  assert.strictEqual(determineStatus({ spreadsheetId: 'abc', cloudModifiedTime: null, lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z', localExists: false, apiError: null, localChanged: true }), 'missing_local');
});

test('suggestDirection：已同步不操作；缺失下载；云端更新且本地未改下载；仅本地改上传；两边改冲突；未同步比时间', () => {
  const { suggestDirection } = require('../lib/status');
  const cloud = '2026-11-04T10:00:00.000Z';
  const later = '2026-11-04T11:00:00.000Z';
  const earlier = '2026-11-03T00:00:00.000Z';
  assert.strictEqual(suggestDirection({ status: 'synced', cloudModifiedTime: cloud, localMtime: later }), null);
  assert.strictEqual(suggestDirection({ status: 'error', cloudModifiedTime: cloud }), null);
  assert.strictEqual(suggestDirection({ status: 'missing_local', cloudModifiedTime: cloud, localMtime: null }), 'download');
  // git 拉取刷新了本地修改时间但内容没变：仍应下载，不能建议上传覆盖云端新改动
  assert.strictEqual(suggestDirection({ status: 'updated', cloudModifiedTime: cloud, localMtime: later, localChanged: false }), 'download');
  // 两边都改过：冲突，不管修改时间谁新都不自动选方向
  assert.strictEqual(suggestDirection({ status: 'conflict', cloudModifiedTime: cloud, localMtime: later, localChanged: true }), 'conflict');
  assert.strictEqual(suggestDirection({ status: 'conflict', cloudModifiedTime: cloud, localMtime: earlier, localChanged: true }), 'conflict');
  assert.strictEqual(suggestDirection({ status: 'local_changed', cloudModifiedTime: cloud, localMtime: earlier, localChanged: true }), 'upload');
  assert.strictEqual(suggestDirection({ status: 'never_synced', cloudModifiedTime: cloud, localMtime: earlier }), 'download');
  assert.strictEqual(suggestDirection({ status: 'never_synced', cloudModifiedTime: cloud, localMtime: later }), 'upload');
  assert.strictEqual(suggestDirection({ status: 'never_synced', cloudModifiedTime: null, localMtime: earlier }), null);
});

test('uploadConflict：云端在基准之后又被改过 → 冲突；force 或无基准放行', () => {
  const { uploadConflict } = require('../lib/status');
  const t1 = '2026-11-01T00:00:00.000Z';
  const t2 = '2026-11-02T00:00:00.000Z';
  // 差异预览看到的是 t1，上传时云端已是 t2
  assert.deepStrictEqual(uploadConflict({ cloudModifiedTime: t2, expect: t1 }), { baseline: t1 });
  // 云端没再变
  assert.strictEqual(uploadConflict({ cloudModifiedTime: t1, expect: t1 }), null);
  // expect 优先于同步记录：用户已在预览里看过 t2 的版本，即使同步记录还是 t1 也放行
  assert.strictEqual(uploadConflict({ cloudModifiedTime: t2, expect: t2, lastSyncedModifiedTime: t1 }), null);
  // 没有 expect 时退回同步记录 / 缓存
  assert.ok(uploadConflict({ cloudModifiedTime: t2, lastSyncedModifiedTime: t1 }));
  assert.ok(uploadConflict({ cloudModifiedTime: t2, cachedModifiedTime: t1 }));
  assert.strictEqual(uploadConflict({ cloudModifiedTime: t2, expect: t1, force: true }), null);
  assert.strictEqual(uploadConflict({ cloudModifiedTime: t2 }), null);
});
