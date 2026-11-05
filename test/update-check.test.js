const { test } = require('node:test');
const assert = require('node:assert');
const { checkForUpdate, compareVersions, driveIdOf } = require('../lib/update-check');

test('compareVersions', () => {
  assert.strictEqual(compareVersions('1.2.0', '1.1.9'), 1);
  assert.strictEqual(compareVersions('v1.0', '1.0.0'), 0);
  assert.strictEqual(compareVersions('1.0.0', '1.0.1'), -1);
  assert.strictEqual(compareVersions('2', '10'), -1);
});

test('driveIdOf 识别 drive: 前缀和 Drive 文件链接', () => {
  assert.strictEqual(driveIdOf('drive:abc_123'), 'abc_123');
  assert.strictEqual(driveIdOf('https://drive.google.com/file/d/XYZ-9/view?usp=sharing'), 'XYZ-9');
  assert.strictEqual(driveIdOf('https://example.com/latest.json'), null);
});

test('checkForUpdate：未配置 / http / drive / 按平台挑下载链接', async () => {
  assert.deepStrictEqual(await checkForUpdate({ source: '', current: '1.0.0' }), { configured: false, current: '1.0.0', hasUpdate: false });
  const manifest = { version: '1.1.0', notes: 'n', downloads: { 'darwin-arm64': 'A', 'darwin-x64': 'X' } };
  const r1 = await checkForUpdate({ source: 'https://h/latest.json', current: '1.0.0', platform: 'darwin', arch: 'x64', fetchJson: async () => manifest });
  assert.strictEqual(r1.hasUpdate, true);
  assert.strictEqual(r1.download, 'X');
  let askedId = null;
  const r2 = await checkForUpdate({ source: 'drive:F1', current: '1.1.0', platform: 'darwin', arch: 'arm64', fetchDrive: async id => { askedId = id; return manifest; } });
  assert.strictEqual(askedId, 'F1');
  assert.strictEqual(r2.hasUpdate, false);
  await assert.rejects(checkForUpdate({ source: 'https://h', current: '1.0.0', fetchJson: async () => ({}) }), /缺少 version/);
  await assert.rejects(checkForUpdate({ source: 'drive:F1', current: '1.0.0' }), /需要 Google 授权/);
});
