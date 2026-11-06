const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  loadBookmarks,
  saveBookmarks,
  getBookmarks,
  addBookmark,
  updateBookmark,
  deleteBookmark,
  validateBookmarkInput
} = require('../lib/bookmarks');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-bm-'));
  return path.join(dir, 'bookmarks.json');
}

test('bookmarks: 文件不存在时返回空列表并支持正常保存', () => {
  const file = tmpFile();
  const res = getBookmarks(file, 'proj-1');
  assert.deepStrictEqual(res.bookmarks, []);
  assert.strictEqual(res.projectCount, 0);
  assert.strictEqual(res.globalCount, 0);
});

test('bookmarks: 添加项目文档与全局文档，并按 projectId 正确筛选', () => {
  const file = tmpFile();
  const bm1 = addBookmark(file, {
    title: '钉钉项目表',
    url: 'https://alidocs.dingtalk.com/spreadsheetv2/Qvmjm92wFWkJQ3DD/edit',
    scope: 'project',
    projectId: 'proj-1',
    description: '项目专用表'
  });
  assert.ok(bm1.id);
  assert.strictEqual(bm1.scope, 'project');

  const bm2 = addBookmark(file, {
    title: '全局规范文档',
    url: 'https://docs.google.com/spreadsheets/d/test',
    scope: 'global',
    description: '公共文档'
  });
  assert.strictEqual(bm2.scope, 'global');

  // 查询 proj-1：包含 1 个项目文档 + 1 个全局文档
  const resProj1 = getBookmarks(file, 'proj-1');
  assert.strictEqual(resProj1.bookmarks.length, 2);
  assert.strictEqual(resProj1.projectCount, 1);
  assert.strictEqual(resProj1.globalCount, 1);

  // 查询 proj-2：仅包含 1 个全局文档
  const resProj2 = getBookmarks(file, 'proj-2');
  assert.strictEqual(resProj2.bookmarks.length, 1);
  assert.strictEqual(resProj2.bookmarks[0].id, bm2.id);
  assert.strictEqual(resProj2.projectCount, 0);
  assert.strictEqual(resProj2.globalCount, 1);
});

test('bookmarks: URL 与标题校验拦截', () => {
  assert.strictEqual(validateBookmarkInput({ title: '', url: 'https://foo.com' }).valid, false);
  assert.strictEqual(validateBookmarkInput({ title: '表', url: 'javascript:alert(1)' }).valid, false);
  assert.strictEqual(validateBookmarkInput({ title: '表', url: 'ftp://foo.com' }).valid, false);
  assert.strictEqual(validateBookmarkInput({ title: '表', url: 'https://foo.com' }).valid, true);
  assert.strictEqual(validateBookmarkInput({ title: '表', url: 'http://foo.com' }).valid, true);
});

test('bookmarks: 修改与删除文档', () => {
  const file = tmpFile();
  const bm = addBookmark(file, { title: '初始标题', url: 'https://a.com' });
  const updated = updateBookmark(file, bm.id, { title: '新标题', description: '新备注' });
  assert.strictEqual(updated.title, '新标题');
  assert.strictEqual(updated.description, '新备注');

  const delOk = deleteBookmark(file, bm.id);
  assert.strictEqual(delOk, true);
  const after = getBookmarks(file);
  assert.strictEqual(after.bookmarks.length, 0);
});

test('bookmarks: 损毁 JSON 安全降级', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'INVALID JSON!!!');
  const res = getBookmarks(file);
  assert.deepStrictEqual(res.bookmarks, []);
});

test('bookmarks API: GET, POST, PUT, DELETE 完整生命周期', async () => {
  const { main } = require('../server');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-api-bm-'));
  const { port, server } = await main({
    dataDir,
    openBrowser: false
  });
  const baseUrl = `http://localhost:${port}`;

  try {
    // 1. GET 初始为空
    let res = await fetch(`${baseUrl}/api/bookmarks?projectId=test-p`);
    let data = await res.json();
    assert.strictEqual(data.bookmarks.length, 0);

    // 2. POST 添加项目文档
    res = await fetch(`${baseUrl}/api/bookmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '钉钉文档',
        url: 'https://alidocs.dingtalk.com/spreadsheetv2/Qvmjm92wFWkJQ3DD/edit',
        scope: 'project',
        projectId: 'test-p',
        description: '钉钉测试表'
      })
    });
    assert.strictEqual(res.status, 201);
    const created = await res.json();
    assert.ok(created.bookmark && created.bookmark.id);

    // 3. GET 带 projectId 查出
    res = await fetch(`${baseUrl}/api/bookmarks?projectId=test-p`);
    data = await res.json();
    assert.strictEqual(data.bookmarks.length, 1);
    assert.strictEqual(data.projectCount, 1);

    // 4. PUT 更新
    res = await fetch(`${baseUrl}/api/bookmarks/${created.bookmark.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '钉钉文档已更新' })
    });
    assert.strictEqual(res.status, 200);
    const updated = await res.json();
    assert.strictEqual(updated.bookmark.title, '钉钉文档已更新');

    // 5. DELETE 删除
    res = await fetch(`${baseUrl}/api/bookmarks/${created.bookmark.id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
    res = await fetch(`${baseUrl}/api/bookmarks?projectId=test-p`);
    data = await res.json();
    assert.strictEqual(data.bookmarks.length, 0);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('bookmarks: 真实钉钉在线表格多参数长链接完整性测试', () => {
  const file = tmpFile();
  const dingUrl = 'https://alidocs.dingtalk.com/spreadsheetv2/Qvmjm92wFWkJQ3DD/edit?cid=433668443:636958280&type=s&docKey=pLdn55XPExK27no8&dentryKey=Qvmjm92wFWkJQ3DD&utm_source=im&utm_medium=im_card&dontjump=true&chInfo=im';
  const bm = addBookmark(file, {
    title: '数值关卡总表',
    url: dingUrl,
    scope: 'project',
    projectId: 'configs-3dd5ea',
    description: '核心关卡配置与掉落参数表'
  });

  assert.strictEqual(bm.url, dingUrl);
  const res = getBookmarks(file, 'configs-3dd5ea');
  assert.strictEqual(res.bookmarks.length, 1);
  assert.strictEqual(res.bookmarks[0].url, dingUrl);
  assert.strictEqual(res.bookmarks[0].title, '数值关卡总表');
  assert.strictEqual(res.bookmarks[0].projectId, 'configs-3dd5ea');
});


