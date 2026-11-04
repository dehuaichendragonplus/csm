const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadFilelist } = require('../lib/filelist-loader');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'filelist-test-'));
}

test('loadFilelist parses valid JSON and resolves savePath', () => {
  const dir = tmpDir();
  const filelistPath = path.join(dir, 'filelist.json');
  fs.writeFileSync(filelistPath, JSON.stringify([
    { path: 'Datas/MergeGame/MergeGame.xlsx', spreadsheetId: 'abc', description: 'MergeGame Sheet', name: 'MergeGame' }
  ]));
  const result = loadFilelist(filelistPath);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].name, 'MergeGame');
  assert.strictEqual(result[0].savePath, path.resolve(dir, 'Datas/MergeGame/MergeGame.xlsx'));
});

test('loadFilelist marks entries with missing spreadsheetId', () => {
  const dir = tmpDir();
  const filelistPath = path.join(dir, 'filelist.json');
  fs.writeFileSync(filelistPath, JSON.stringify([
    { path: 'Datas/X.xlsx', spreadsheetId: '', description: 'X', name: 'X' }
  ]));
  const result = loadFilelist(filelistPath);
  assert.strictEqual(result[0].incomplete, true);
  assert.match(result[0].incompleteReason, /spreadsheetId/);
});

test('loadFilelist throws when file does not exist', () => {
  assert.throws(() => loadFilelist('/nonexistent/path/filelist.json'), /not found/i);
});

test('loadFilelist throws when JSON is invalid', () => {
  const dir = tmpDir();
  const filelistPath = path.join(dir, 'filelist.json');
  fs.writeFileSync(filelistPath, '{not valid');
  assert.throws(() => loadFilelist(filelistPath), /JSON/i);
});

test('loadFilelist throws when content is not an array', () => {
  const dir = tmpDir();
  const filelistPath = path.join(dir, 'filelist.json');
  fs.writeFileSync(filelistPath, JSON.stringify({}));
  assert.throws(() => loadFilelist(filelistPath), /array/i);
});
