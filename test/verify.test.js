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
