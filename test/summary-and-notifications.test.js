const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { main } = require('../server');

function tmpDir(prefix = 'csm-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('projects-summary, badge, and notify APIs', async () => {
  const dataDir = tmpDir('csm-data-');
  const projDir = tmpDir('csm-proj-');

  // 创建一个测试项目结构
  const filelist = [
    { path: 'Datas/Hero.xlsx', name: 'Hero', spreadsheetId: 'sheet-hero-123' },
    { path: 'Datas/Monster.xlsx', name: 'Monster', spreadsheetId: 'sheet-monster-456' }
  ];
  fs.mkdirSync(path.join(projDir, 'Datas'), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'filelist.json'), JSON.stringify(filelist));
  fs.writeFileSync(path.join(projDir, 'Datas/Hero.xlsx'), 'dummy-hero-content');

  fs.writeFileSync(
    path.join(projDir, 'syncmanager.config.json'),
    JSON.stringify({
      title: 'TestGame',
      filelist: 'filelist.json'
    })
  );

  // 注册该项目到 dataDir/projects.json
  const projectsJson = [
    { id: 'proj-test-1', name: 'TestGame', dir: projDir }
  ];
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify(projectsJson));

  let badgeCalls = [];
  let notifyCalls = [];

  const { port, server } = await main({
    dataDir,
    port: 0,
    openBrowser: false,
    setBadge: count => { badgeCalls.push(count); },
    showNotification: payload => { notifyCalls.push(payload); return true; }
  });

  try {
    // 1. 测试 /api/projects-summary
    const resSummary = await fetch(`http://127.0.0.1:${port}/api/projects-summary`);
    assert.strictEqual(resSummary.status, 200);
    const dataSummary = await resSummary.json();
    assert.strictEqual(Array.isArray(dataSummary.projects), true);
    assert.strictEqual(dataSummary.projects.length, 1);
    assert.strictEqual(dataSummary.projects[0].name, 'TestGame');
    assert.strictEqual(dataSummary.projects[0].total, 2);
    // Hero 存在但未记录同步状态（never_synced -> pending），Monster 本地缺失（missing_local -> pending）
    assert.strictEqual(dataSummary.projects[0].pending, 2);
    assert.strictEqual(dataSummary.totalPending, 2);

    // 2. 测试 POST /api/badge
    const resBadge = await fetch(`http://127.0.0.1:${port}/api/badge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 7 })
    });
    assert.strictEqual(resBadge.status, 200);
    const dataBadge = await resBadge.json();
    assert.strictEqual(dataBadge.ok, true);
    assert.strictEqual(dataBadge.count, 7);
    assert.deepStrictEqual(badgeCalls, [7]);

    // 3. 测试 POST /api/notify
    const resNotify = await fetch(`http://127.0.0.1:${port}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'CSM 测试', body: '2 张表有更新' })
    });
    assert.strictEqual(resNotify.status, 200);
    const dataNotify = await resNotify.json();
    assert.strictEqual(dataNotify.ok, true);
    assert.strictEqual(dataNotify.shown, true);
    assert.strictEqual(notifyCalls.length, 1);
    assert.strictEqual(notifyCalls[0].title, 'CSM 测试');
    assert.strictEqual(notifyCalls[0].body, '2 张表有更新');

    // 4. 测试 GET /api/projects 包含 exists 字段
    const resProjects = await fetch(`http://127.0.0.1:${port}/api/projects`);
    assert.strictEqual(resProjects.status, 200);
    const dataProjects = await resProjects.json();
    assert.strictEqual(dataProjects[0].exists, true);

    // 5. 测试 PATCH /api/projects/:id 更新项目目录与名称
    const newProjDir = tmpDir('csm-new-proj-');
    fs.writeFileSync(path.join(newProjDir, 'syncmanager.config.json'), JSON.stringify({ title: 'NewTestGame', filelist: 'filelist.json' }));
    fs.writeFileSync(path.join(newProjDir, 'filelist.json'), '[]');

    const resPatch = await fetch(`http://127.0.0.1:${port}/api/projects/proj-test-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: newProjDir, name: 'RenamedGame' })
    });
    assert.strictEqual(resPatch.status, 200);
    const patchData = await resPatch.json();
    assert.strictEqual(patchData.dir, newProjDir);
    assert.strictEqual(patchData.name, 'RenamedGame');
    assert.strictEqual(patchData.exists, true);

    // 再次查 GET /api/projects 验证已持久化
    const resProjectsAfter = await fetch(`http://127.0.0.1:${port}/api/projects`);
    const dataProjectsAfter = await resProjectsAfter.json();
    assert.strictEqual(dataProjectsAfter[0].dir, newProjDir);
    assert.strictEqual(dataProjectsAfter[0].name, 'RenamedGame');
    fs.rmSync(newProjDir, { recursive: true, force: true });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projDir, { recursive: true, force: true });
  }
});
