const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadSidecar, saveSidecar, updateSidecar } = require('../lib/version-sidecar');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
}

test('loadSidecar returns empty when file does not exist', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(loadSidecar(path.join(dir, '.sync-versions.json')), {});
});

test('loadSidecar returns empty when JSON corrupt', () => {
  const dir = tmpDir();
  const p = path.join(dir, '.sync-versions.json');
  fs.writeFileSync(p, '{not valid');
  assert.deepStrictEqual(loadSidecar(p), {});
});

test('saveSidecar writes sorted keys', () => {
  const dir = tmpDir();
  const p = path.join(dir, '.sync-versions.json');
  saveSidecar(p, { 'b.xlsx': 'B', 'a.xlsx': 'A' });
  const raw = fs.readFileSync(p, 'utf8');
  assert.match(raw, /"a\.xlsx"[\s\S]*"b\.xlsx"/);
});

test('updateSidecar merges and persists', () => {
  const dir = tmpDir();
  const p = path.join(dir, '.sync-versions.json');
  saveSidecar(p, { 'a.xlsx': 'A' });
  updateSidecar(p, 'b.xlsx', 'B');
  assert.deepStrictEqual(loadSidecar(p), { 'a.xlsx': 'A', 'b.xlsx': 'B' });
});

test('updateSidecar overwrites existing key', () => {
  const dir = tmpDir();
  const p = path.join(dir, '.sync-versions.json');
  saveSidecar(p, { 'a.xlsx': 'OLD' });
  updateSidecar(p, 'a.xlsx', 'NEW');
  assert.strictEqual(loadSidecar(p)['a.xlsx'], 'NEW');
});
