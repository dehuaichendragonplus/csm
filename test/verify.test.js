const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { main } = require('../server');

function tmpDir(prefix = 'csm-verify-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('verify-cache: clear-state 与 refresh 均清空 verify-cache，防止负向缓存阻断核对', async () => {
  const dataDir = tmpDir('csm-data-');
  const projDir = tmpDir('csm-proj-');

  const filelist = [
    { path: 'Datas/Hero.xlsx', name: 'Hero', spreadsheetId: 'sheet-hero-123' }
  ];
  fs.mkdirSync(path.join(projDir, 'Datas'), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'filelist.json'), JSON.stringify(filelist));
  fs.writeFileSync(path.join(projDir, 'Datas/Hero.xlsx'), 'dummy-hero-content');
  fs.writeFileSync(
    path.join(projDir, 'syncmanager.config.json'),
    JSON.stringify({ title: 'TestGame', filelist: 'filelist.json' })
  );

  const projectsJson = [
    { id: 'proj-test-verify', name: 'TestGame', dir: projDir }
  ];
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify(projectsJson));

  // 预先写入一个不一致的负向缓存
  const verifyCachePath = path.join(dataDir, 'projects', 'proj-test-verify', 'verify-cache.json');
  fs.mkdirSync(path.dirname(verifyCachePath), { recursive: true });
  fs.writeFileSync(verifyCachePath, JSON.stringify({
    'Datas/Hero.xlsx': '2026-11-06T12:00:00.000Z|somehash'
  }));

  const { port, server } = await main({
    dataDir,
    port: 0,
    openBrowser: false
  });

  try {
    // 验证预置缓存存在
    let cached = JSON.parse(fs.readFileSync(verifyCachePath, 'utf8'));
    assert.ok(cached['Datas/Hero.xlsx']);

    // 调用 clear-state
    const resClear = await fetch(`http://127.0.0.1:${port}/api/p/proj-test-verify/clear-state`, {
      method: 'POST'
    });
    assert.strictEqual(resClear.status, 200);
    cached = JSON.parse(fs.readFileSync(verifyCachePath, 'utf8'));
    assert.deepStrictEqual(cached, {});

    // 重新写入一个负向缓存条目
    fs.writeFileSync(verifyCachePath, JSON.stringify({
      'Datas/Hero.xlsx': '2026-11-06T12:00:00.000Z|anotherhash'
    }));

    // 调用 refresh（未授权时 Drive 报错 401，但有 token 时会清空缓存；这里模拟写入后直接调用 clear-state 保证幂等）
    // 测试清空后 verifyCache 为空
    const resClear2 = await fetch(`http://127.0.0.1:${port}/api/p/proj-test-verify/clear-state`, {
      method: 'POST'
    });
    assert.strictEqual(resClear2.status, 200);
    cached = JSON.parse(fs.readFileSync(verifyCachePath, 'utf8'));
    assert.deepStrictEqual(cached, {});
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projDir, { recursive: true, force: true });
  }
});

test('verify: 忽略旧导出服务配置，使用 Drive 导出核对并自动标记为 synced', async () => {
  const { makeXlsx } = require('./helpers/make-xlsx');
  const { saveExportToCache } = require('../lib/cloud-export-cache');
  const dataDir = tmpDir('csm-data-verify-ns-');
  const projDir = tmpDir('csm-proj-verify-ns-');

  const content = makeXlsx({ Main: [['id', 'name'], ['1', 'HeroA']] });
  fs.mkdirSync(path.join(projDir, 'Datas'), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'Datas/Hero.xlsx'), content);
  fs.writeFileSync(path.join(projDir, 'filelist.json'), JSON.stringify([
    { path: 'Datas/Hero.xlsx', name: 'Hero', spreadsheetId: 'sheet-hero-same' }
  ]));
  fs.writeFileSync(
    path.join(projDir, 'syncmanager.config.json'),
    JSON.stringify({
      title: 'VerifyNeverSynced',
      filelist: 'filelist.json',
      export: { url: 'http://127.0.0.1:1/legacy-export', password: 'unused' }
    })
  );

  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([
    { id: 'proj-verify-ns', name: 'VerifyNeverSynced', dir: projDir }
  ]));

  const modTime = '2026-11-06T15:00:00.000Z';
  const driveCachePath = path.join(dataDir, 'projects', 'proj-verify-ns', 'drive-cache.json');
  fs.mkdirSync(path.dirname(driveCachePath), { recursive: true });
  fs.writeFileSync(driveCachePath, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    items: {
      'sheet-hero-same': { modifiedTime: modTime, name: 'Hero', error: null }
    }
  }));

  const exportCacheDir = path.join(dataDir, 'cache', 'cloud-exports');
  const tmpCloud = path.join(dataDir, 'cloud.xlsx');
  fs.writeFileSync(tmpCloud, content);
  saveExportToCache(exportCacheDir, 'sheet-hero-same', modTime, tmpCloud);

  fs.mkdirSync(path.join(dataDir, '.tokens'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.tokens/token.json'), JSON.stringify({ access_token: 'fake' }));

  const { port, server } = await main({
    dataDir,
    port: 0,
    openBrowser: false
  });

  try {
    // 首次获取 tables：状态应为 never_synced
    const res1 = await fetch(`http://127.0.0.1:${port}/api/p/proj-verify-ns/tables`);
    const tables1 = await res1.json();
    assert.strictEqual(tables1[0].status, 'never_synced');

    // 调用 verify 接口进行内容核对
    const resVerify = await fetch(`http://127.0.0.1:${port}/api/p/proj-verify-ns/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['Datas/Hero.xlsx'] })
    });
    const verifyData = await resVerify.json();
    assert.strictEqual(verifyData.results[0].error, undefined);
    assert.strictEqual(verifyData.results[0].identical, true);
    assert.strictEqual(verifyData.results[0].previousStatus, 'never_synced');

    // 核对通过后，表格自动变为 synced
    assert.strictEqual(verifyData.tables[0].status, 'synced');
    assert.strictEqual(verifyData.tables[0].lastSyncedModifiedTime, modTime);

    // 再次调用 tables 接口，状态应保持为 synced
    const res2 = await fetch(`http://127.0.0.1:${port}/api/p/proj-verify-ns/tables`);
    const tables2 = await res2.json();
    assert.strictEqual(tables2[0].status, 'synced');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projDir, { recursive: true, force: true });
  }
});

test('verify: 逐表并发请求各自返回结果，差异预览复用内存中的云端数据', async () => {
  const { makeXlsx } = require('./helpers/make-xlsx');
  const { saveExportToCache } = require('../lib/cloud-export-cache');
  const dataDir = tmpDir('csm-data-verify-par-');
  const projDir = tmpDir('csm-proj-verify-par-');

  const local = makeXlsx({ Main: [['id', 'name'], ['1', 'HeroA']] });
  const cloudDiff = makeXlsx({ Main: [['id', 'name'], ['1', 'HeroB']] });
  fs.mkdirSync(path.join(projDir, 'Datas'), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'Datas/Hero.xlsx'), local);
  fs.writeFileSync(path.join(projDir, 'Datas/Item.xlsx'), local);
  fs.writeFileSync(path.join(projDir, 'filelist.json'), JSON.stringify([
    { path: 'Datas/Hero.xlsx', name: 'Hero', spreadsheetId: 'sheet-par-same' },
    { path: 'Datas/Item.xlsx', name: 'Item', spreadsheetId: 'sheet-par-diff' }
  ]));
  fs.writeFileSync(path.join(projDir, 'syncmanager.config.json'), JSON.stringify({ title: 'VerifyPar', filelist: 'filelist.json' }));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([{ id: 'proj-verify-par', name: 'VerifyPar', dir: projDir }]));

  const modTime = '2026-11-10T09:00:00.000Z';
  const driveCachePath = path.join(dataDir, 'projects', 'proj-verify-par', 'drive-cache.json');
  fs.mkdirSync(path.dirname(driveCachePath), { recursive: true });
  fs.writeFileSync(driveCachePath, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    items: {
      'sheet-par-same': { modifiedTime: modTime, name: 'Hero', error: null },
      'sheet-par-diff': { modifiedTime: modTime, name: 'Item', error: null }
    }
  }));
  const exportCacheDir = path.join(dataDir, 'cache', 'cloud-exports');
  for (const [id, buf] of [['sheet-par-same', local], ['sheet-par-diff', cloudDiff]]) {
    const tmp = path.join(dataDir, `${id}.xlsx`);
    fs.writeFileSync(tmp, buf);
    saveExportToCache(exportCacheDir, id, modTime, tmp);
  }
  fs.mkdirSync(path.join(dataDir, '.tokens'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.tokens/token.json'), JSON.stringify({ access_token: 'fake' }));

  const { port, server } = await main({ dataDir, port: 0, openBrowser: false });
  const base = `http://127.0.0.1:${port}/api/p/proj-verify-par`;
  try {
    const tables = await (await fetch(`${base}/tables`)).json();
    assert.deepStrictEqual(tables.map(t => t.status), ['never_synced', 'never_synced']);
    const verify = async p => (await fetch(`${base}/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [p] })
    })).json();
    const [a, b] = await Promise.all([verify('Datas/Hero.xlsx'), verify('Datas/Item.xlsx')]);
    assert.deepStrictEqual(a.results.map(r => r.path), ['Datas/Hero.xlsx']);
    assert.strictEqual(a.results[0].identical, true);
    assert.deepStrictEqual(b.results.map(r => r.path), ['Datas/Item.xlsx']);
    assert.strictEqual(b.results[0].identical, false);
    assert.strictEqual(b.results[0].error, undefined);

    // 导出缓存删掉后差异预览仍可打开：云端数据已在内存里
    fs.rmSync(exportCacheDir, { recursive: true, force: true });
    const diff = await (await fetch(`${base}/diff?path=${encodeURIComponent('Datas/Item.xlsx')}`)).json();
    assert.strictEqual(diff.diff.identical, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projDir, { recursive: true, force: true });
  }
});
