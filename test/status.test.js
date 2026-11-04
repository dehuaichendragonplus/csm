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

test('updated takes precedence over local_changed', () => {
  // When cloud has a newer version AND local has been modified externally,
  // we surface "updated" because pulling cloud fixes both.
  assert.strictEqual(determineStatus({ spreadsheetId: 'abc', cloudModifiedTime: '2026-05-27T14:30:00.000Z', lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z', localExists: true, apiError: null, localChanged: true }), 'updated');
});

test('missing_local takes precedence over local_changed', () => {
  assert.strictEqual(determineStatus({ spreadsheetId: 'abc', cloudModifiedTime: null, lastSyncedModifiedTime: '2026-05-20T08:15:22.000Z', localExists: false, apiError: null, localChanged: true }), 'missing_local');
});
