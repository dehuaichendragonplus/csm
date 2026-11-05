const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadState, saveState, updateEntry } = require('../lib/sync-state');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sync-state-test-'));
}

test('loadState returns empty object when file does not exist', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, '.sync_state.json');
  assert.deepStrictEqual(loadState(statePath), {});
});

test('loadState returns parsed object when valid', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, '.sync_state.json');
  fs.writeFileSync(statePath, JSON.stringify({ 'foo.xlsx': { lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z' } }));
  assert.deepStrictEqual(loadState(statePath), {
    'foo.xlsx': { lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z' }
  });
});

test('loadState backs up corrupt file and returns empty', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, '.sync_state.json');
  fs.writeFileSync(statePath, '{not valid json');
  const result = loadState(statePath);
  assert.deepStrictEqual(result, {});
  const files = fs.readdirSync(dir);
  assert.ok(files.some(f => f.startsWith('.sync_state.json.bak.')));
});

test('saveState writes JSON to disk', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, '.sync_state.json');
  saveState(statePath, { 'foo.xlsx': { lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z', lastSyncedAt: '2026-05-20T08:30:00.000Z' } });
  const raw = fs.readFileSync(statePath, 'utf8');
  const parsed = JSON.parse(raw);
  assert.strictEqual(parsed['foo.xlsx'].lastSyncedModifiedTime, '2026-05-20T08:15:22.000Z');
});

test('updateEntry adds a new entry and persists', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, '.sync_state.json');
  updateEntry(statePath, 'bar.xlsx', { lastSyncedModifiedTime: '2026-05-21T00:00:00.000Z' });
  const state = loadState(statePath);
  assert.strictEqual(state['bar.xlsx'].lastSyncedModifiedTime, '2026-05-21T00:00:00.000Z');
  assert.ok(state['bar.xlsx'].lastSyncedAt); // auto-set
});

test('updateEntry preserves existing entries', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, '.sync_state.json');
  saveState(statePath, { 'foo.xlsx': { lastSyncedModifiedTime: 'A' } });
  updateEntry(statePath, 'bar.xlsx', { lastSyncedModifiedTime: 'B' });
  const state = loadState(statePath);
  assert.strictEqual(state['foo.xlsx'].lastSyncedModifiedTime, 'A');
  assert.strictEqual(state['bar.xlsx'].lastSyncedModifiedTime, 'B');
});

test('hashFile：内容不变时复用缓存；内容和修改时间变了会重新计算', () => {
  const { hashFile } = require('../lib/sync-state');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hash-')), 'a.xlsx');
  fs.writeFileSync(f, 'one');
  const h1 = hashFile(f);
  assert.strictEqual(hashFile(f), h1);
  fs.writeFileSync(f, 'two');
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  assert.notStrictEqual(hashFile(f), h1);
  assert.strictEqual(hashFile(path.join(path.dirname(f), 'missing.xlsx')), null);
});
