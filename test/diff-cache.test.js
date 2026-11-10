'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { main } = require('../server');
const { makeXlsx } = require('./helpers/make-xlsx');

function tmpDir(prefix = 'csm-diff-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('diff API: uses cloud export cache and avoids redundant downloads', async () => {
  const dataDir = tmpDir('csm-data-diff-');
  const projDir = tmpDir('csm-proj-diff-');

  const localXlsx = makeXlsx({ Main: [['id', 'name'], ['1', 'Local']] });
  const cloudXlsx = makeXlsx({ Main: [['id', 'name'], ['1', 'Cloud']] });

  fs.mkdirSync(path.join(projDir, 'Datas'), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'Datas/Hero.xlsx'), localXlsx);
  fs.writeFileSync(path.join(projDir, 'filelist.json'), JSON.stringify([
    { path: 'Datas/Hero.xlsx', name: 'Hero', spreadsheetId: 'sheet-hero-999' }
  ]));
  fs.writeFileSync(
    path.join(projDir, 'syncmanager.config.json'),
    JSON.stringify({ title: 'DiffTest', filelist: 'filelist.json' })
  );

  const projectsJson = [
    { id: 'proj-diff-test', name: 'DiffTest', dir: projDir }
  ];
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify(projectsJson));

  // 预热 drive-cache 和 cloud-exports 缓存
  const modTime = '2026-11-06T10:00:00.000Z';
  const driveCachePath = path.join(dataDir, 'projects', 'proj-diff-test', 'drive-cache.json');
  fs.mkdirSync(path.dirname(driveCachePath), { recursive: true });
  fs.writeFileSync(driveCachePath, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    items: {
      'sheet-hero-999': { modifiedTime: modTime, name: 'HeroCloud', error: null }
    }
  }));

  const { saveExportToCache } = require('../lib/cloud-export-cache');
  const exportCacheDir = path.join(dataDir, 'cache', 'cloud-exports');
  const tmpSrc = path.join(tmpDir(), 'cloud.xlsx');
  fs.writeFileSync(tmpSrc, cloudXlsx);
  saveExportToCache(exportCacheDir, 'sheet-hero-999', modTime, tmpSrc);

  // 假令牌使 hasToken 为真
  fs.mkdirSync(path.join(dataDir, '.tokens'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.tokens/token.json'), JSON.stringify({ access_token: 'fake' }));

  const { port, server } = await main({
    dataDir,
    port: 0,
    openBrowser: false
  });

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/p/proj-diff-test/diff?path=Datas/Hero.xlsx`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.path, 'Datas/Hero.xlsx');
    assert.strictEqual(data.downloadVersion.cloudModifiedTime, modTime);
    assert.strictEqual(data.diff.identical, false);
    assert.strictEqual(data.diff.sheets[0].changes.length, 1);
    assert.strictEqual(data.diff.sheets[0].changes[0].cells[0].local, 'Local');
    assert.strictEqual(data.diff.sheets[0].changes[0].cells[0].cloud, 'Cloud');
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projDir, { recursive: true, force: true });
  }
});
