'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  getMemoryWorkbook,
  setMemoryWorkbook,
  clearMemoryWorkbooks,
  localMemoryKey,
  cloudMemoryKey,
  cloudExportFilename,
  getCachedExportPath,
  saveExportToCache,
  singleFlightExport,
  pruneOldExports
} = require('../lib/cloud-export-cache');

test('cloud-export-cache: memory workbook cache LRU and clear', () => {
  clearMemoryWorkbooks();
  assert.strictEqual(getMemoryWorkbook('k1'), null);

  const wb1 = [{ name: 'S1', rows: [['a']] }];
  const wb2 = [{ name: 'S2', rows: [['b']] }];
  setMemoryWorkbook('k1', wb1, 2);
  setMemoryWorkbook('k2', wb2, 2);
  assert.strictEqual(getMemoryWorkbook('k1'), wb1);
  assert.strictEqual(getMemoryWorkbook('k2'), wb2);

  const wb3 = [{ name: 'S3', rows: [['c']] }];
  // Access k1 so k2 becomes the oldest
  getMemoryWorkbook('k1');
  setMemoryWorkbook('k3', wb3, 2);

  assert.strictEqual(getMemoryWorkbook('k1'), wb1);
  assert.strictEqual(getMemoryWorkbook('k3'), wb3);
  assert.strictEqual(getMemoryWorkbook('k2'), null); // evicted

  clearMemoryWorkbooks();
  assert.strictEqual(getMemoryWorkbook('k1'), null);
});

test('cloud-export-cache: keys and filenames', () => {
  const stat = { mtimeMs: 123456789, size: 500 };
  assert.strictEqual(localMemoryKey('/path/to/table.xlsx', stat), 'local:/path/to/table.xlsx:123456789:500');

  const cmk = cloudMemoryKey('sheet-1', '2026-02-02T08:00:00.000Z');
  assert.strictEqual(cmk, 'cloud:sheet-1:2026-02-02T08:00:00.000Z');

  const fn1 = cloudExportFilename('sheet-1', '2026-02-02T08:00:00.000Z');
  const fn2 = cloudExportFilename('sheet-1', '2026-02-02T08:00:00.000Z');
  const fn3 = cloudExportFilename('sheet-1', '2026-02-02T09:00:00.000Z');
  assert.strictEqual(fn1, fn2);
  assert.notStrictEqual(fn1, fn3);
});

test('cloud-export-cache: disk save, get, and prune', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-cache-test-'));
  try {
    const srcFile = path.join(tmpDir, 'dummy.xlsx');
    fs.writeFileSync(srcFile, 'test xlsx content');

    const modTime = '2026-02-02T08:00:00.000Z';
    assert.strictEqual(getCachedExportPath(tmpDir, 'sheet-abc', modTime), null);

    const saved = saveExportToCache(tmpDir, 'sheet-abc', modTime, srcFile);
    assert.ok(saved && fs.existsSync(saved));
    assert.strictEqual(fs.readFileSync(saved, 'utf8'), 'test xlsx content');

    const cached = getCachedExportPath(tmpDir, 'sheet-abc', modTime);
    assert.strictEqual(cached, saved);

    // Prune test
    pruneOldExports(tmpDir, { maxFiles: 0, maxAgeMs: 0 });
    assert.strictEqual(getCachedExportPath(tmpDir, 'sheet-abc', modTime), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('cloud-export-cache: singleFlightExport deduplicates concurrent calls', async () => {
  let callCount = 0;
  const slowTask = async () => {
    callCount++;
    await new Promise(r => setTimeout(r, 20));
    return 'done';
  };

  const [res1, res2, res3] = await Promise.all([
    singleFlightExport('task-1', slowTask),
    singleFlightExport('task-1', slowTask),
    singleFlightExport('task-1', slowTask)
  ]);

  assert.strictEqual(callCount, 1);
  assert.strictEqual(res1, 'done');
  assert.strictEqual(res2, 'done');
  assert.strictEqual(res3, 'done');
});

test('invalidateCloudExports：只删指定表的全部导出缓存（内存 + 磁盘），不动其他表', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const c = require('../lib/cloud-export-cache');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-inv-'));
  const src = path.join(dir, 'src.xlsx');
  fs.writeFileSync(src, 'x');
  c.saveExportToCache(dir, 'SHEET_A_1234567890', 't1', src);
  c.saveExportToCache(dir, 'SHEET_A_1234567890', 't2', src);
  c.saveExportToCache(dir, 'SHEET_B_1234567890', 't1', src);
  c.setMemoryWorkbook(c.cloudMemoryKey('SHEET_A_1234567890', 't1'), [{}]);
  c.setMemoryWorkbook(c.cloudMemoryKey('SHEET_B_1234567890', 't1'), [{}]);
  assert.strictEqual(c.invalidateCloudExports(dir, 'SHEET_A_1234567890'), 2);
  assert.strictEqual(c.getCachedExportPath(dir, 'SHEET_A_1234567890', 't1'), null);
  assert.ok(c.getCachedExportPath(dir, 'SHEET_B_1234567890', 't1'));
  assert.strictEqual(c.getMemoryWorkbook(c.cloudMemoryKey('SHEET_A_1234567890', 't1')), null);
  assert.ok(c.getMemoryWorkbook(c.cloudMemoryKey('SHEET_B_1234567890', 't1')));
  fs.rmSync(dir, { recursive: true, force: true });
});
