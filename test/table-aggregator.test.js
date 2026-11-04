const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { aggregateTables } = require('../lib/table-aggregator');

function makeEntry(overrides) {
  return {
    path: 'Datas/X.xlsx',
    name: 'X',
    description: 'X Sheet',
    spreadsheetId: 'abc',
    savePath: '/tmp/does-not-exist/X.xlsx',
    ...overrides
  };
}

test('aggregates synced entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-'));
  const savePath = path.join(dir, 'X.xlsx');
  fs.writeFileSync(savePath, 'x');
  const filelist = [makeEntry({ savePath })];
  const driveMap = new Map([['abc', { modifiedTime: '2026-05-20T08:15:22.000Z', name: 'X', error: null }]]);
  const state = { 'Datas/X.xlsx': { lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z', lastSyncedAt: '2026-05-20T08:30:00.000Z' } };
  const rows = aggregateTables(filelist, driveMap, state);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'synced');
  assert.strictEqual(rows[0].cloudModifiedTime, '2026-05-20T08:15:22.000Z');
  assert.strictEqual(rows[0].lastSyncedModifiedTime, '2026-05-20T08:15:22.000Z');
  assert.strictEqual(rows[0].localExists, true);
});

test('aggregates updated entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-'));
  const savePath = path.join(dir, 'X.xlsx');
  fs.writeFileSync(savePath, 'x');
  const filelist = [makeEntry({ savePath })];
  const driveMap = new Map([['abc', { modifiedTime: '2026-05-27T14:30:00.000Z', name: 'X', error: null }]]);
  const state = { 'Datas/X.xlsx': { lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z' } };
  const rows = aggregateTables(filelist, driveMap, state);
  assert.strictEqual(rows[0].status, 'updated');
});

test('aggregates error when spreadsheetId missing', () => {
  const filelist = [{ ...makeEntry(), spreadsheetId: '', incomplete: true, incompleteReason: 'spreadsheetId is empty' }];
  const rows = aggregateTables(filelist, new Map(), {});
  assert.strictEqual(rows[0].status, 'error');
  assert.match(rows[0].error, /spreadsheetId/);
});

test('aggregates error when Drive returned 403', () => {
  const filelist = [makeEntry()];
  const driveMap = new Map([['abc', { modifiedTime: null, name: null, error: 'forbidden' }]]);
  const rows = aggregateTables(filelist, driveMap, {});
  assert.strictEqual(rows[0].status, 'error');
  assert.strictEqual(rows[0].error, 'forbidden');
});

test('aggregates missing_local when xlsx not on disk', () => {
  const filelist = [makeEntry({ savePath: '/nope/never/exists.xlsx' })];
  const driveMap = new Map([['abc', { modifiedTime: '2026-05-20T08:15:22.000Z', name: 'X', error: null }]]);
  const state = { 'Datas/X.xlsx': { lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z' } };
  const rows = aggregateTables(filelist, driveMap, state);
  assert.strictEqual(rows[0].status, 'missing_local');
});

test('aggregates local_changed when local file size differs from sync record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-'));
  const savePath = path.join(dir, 'X.xlsx');
  fs.writeFileSync(savePath, 'reverted-old-content');
  const st = fs.statSync(savePath);
  const filelist = [makeEntry({ savePath })];
  const driveMap = new Map([['abc', { modifiedTime: '2026-05-20T08:15:22.000Z', name: 'X', error: null }]]);
  const state = {
    'Datas/X.xlsx': {
      lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z',
      lastSyncedSize: st.size + 9999, // intentionally mismatched
      lastSyncedMtime: st.mtime.toISOString()
    }
  };
  const rows = aggregateTables(filelist, driveMap, state);
  assert.strictEqual(rows[0].status, 'local_changed');
});

test('aggregates local_changed when local file mtime differs from sync record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-'));
  const savePath = path.join(dir, 'X.xlsx');
  fs.writeFileSync(savePath, 'data');
  const st = fs.statSync(savePath);
  const filelist = [makeEntry({ savePath })];
  const driveMap = new Map([['abc', { modifiedTime: '2026-05-20T08:15:22.000Z', name: 'X', error: null }]]);
  const state = {
    'Datas/X.xlsx': {
      lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z',
      lastSyncedSize: st.size,
      lastSyncedMtime: '1999-01-01T00:00:00.000Z' // intentionally old
    }
  };
  const rows = aggregateTables(filelist, driveMap, state);
  assert.strictEqual(rows[0].status, 'local_changed');
});

test('stays synced when local file size and mtime match sync record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-'));
  const savePath = path.join(dir, 'X.xlsx');
  fs.writeFileSync(savePath, 'data');
  const st = fs.statSync(savePath);
  const filelist = [makeEntry({ savePath })];
  const driveMap = new Map([['abc', { modifiedTime: '2026-05-20T08:15:22.000Z', name: 'X', error: null }]]);
  const state = {
    'Datas/X.xlsx': {
      lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z',
      lastSyncedSize: st.size,
      lastSyncedMtime: st.mtime.toISOString()
    }
  };
  const rows = aggregateTables(filelist, driveMap, state);
  assert.strictEqual(rows[0].status, 'synced');
});
