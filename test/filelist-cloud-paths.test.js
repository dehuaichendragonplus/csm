'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { google } = require('googleapis');
const { main } = require('../server');

const SHARED = 'shared-sheet-id-for-test';
const UNAVAILABLE = 'unavailable-sheet-id-for-test';
const SHEET_TIME = '2024-05-01T12:00:00.000Z';
const ORIGINAL = JSON.stringify([
  { path: 'Datas/A.xlsx', name: '甲', spreadsheetId: SHARED, cloudDir: '旧目录', cloudFile: '旧名称' },
  { path: 'Datas/B.xlsx', name: '乙', spreadsheetId: SHARED, mergeCells: true },
  { path: 'Datas/C.xlsx', name: '丙', spreadsheetId: UNAVAILABLE, cloudFile: '保留原名' },
  { path: 'Datas/D.xlsx', name: '丁', spreadsheetId: ' ' }
], null, '\t').replaceAll('\n', '\r\n') + '\r\n';

test('管理配置表的路径预览只读，应用时仅写入确认过的路径并拒绝过期预览', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-cloud-paths-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const credentialsPath = path.join(tmp, 'credentials.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({ installed: { client_id: 'test', client_secret: 'test' } }));
  const dataDir = path.join(tmp, 'platform');
  const tokenDir = path.join(dataDir, '.tokens');
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'token.json'), JSON.stringify({ access_token: 'test-token' }));
  const projects = ['project-a', 'project-b'].map(id => ({ id, name: id, dir: path.join(tmp, id) }));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify(projects));

  const config = { filelist: 'filelist.json', sidecar: 'sidecar.json' };
  for (const p of projects) {
    fs.mkdirSync(path.join(p.dir, 'Datas'), { recursive: true });
    fs.writeFileSync(path.join(p.dir, 'Datas/A.xlsx'), 'local content');
    fs.writeFileSync(path.join(p.dir, 'filelist.json'), ORIGINAL);
    fs.writeFileSync(path.join(p.dir, 'sidecar.json'), JSON.stringify({ 'Datas/A.xlsx': SHEET_TIME }));
    fs.writeFileSync(path.join(p.dir, 'syncmanager.config.json'), JSON.stringify(config));
  }
  const filelistPath = path.join(projects[0].dir, 'filelist.json');
  const configPath = path.join(projects[0].dir, 'syncmanager.config.json');

  // 用临时文件测试实际 HTTP 路由和落盘，只有 Google 的请求替换为本地数据。
  t.mock.method(google.auth.OAuth2.prototype, 'request', async () => { throw new Error('使用单项读取'); });
  t.mock.method(google, 'drive', () => ({
    files: {
      async get({ fileId }) {
        if (fileId === SHARED) {
          return { data: { id: SHARED, name: '新名称', parents: ['parent'], mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: SHEET_TIME } };
        }
        if (fileId === 'parent') return { data: { id: 'parent', name: '新目录', mimeType: 'application/vnd.google-apps.folder' } };
        throw Object.assign(new Error('无法访问'), { code: 404 });
      }
    }
  }));

  const { server, port } = await main({ dataDir, credentialsPath, port: 0, openBrowser: false });
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function request(route, body, id = projects[0].id) {
    const options = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    const res = await fetch(`http://127.0.0.1:${port}/api/p/${id}/filelist${route}`, options);
    return { status: res.status, body: await res.json() };
  }

  const listing = await request('');
  assert.equal(listing.status, 200);
  assert.equal(listing.body.entries[0].sync.status, 'synced', '读取 sidecar 时仍能判断已有同步基准');
  assert.equal(fs.readFileSync(filelistPath, 'utf8'), ORIGINAL);

  const preview = await request('/cloud-paths', {});
  assert.equal(preview.status, 200);
  assert.equal(fs.readFileSync(filelistPath, 'utf8'), ORIGINAL);
  assert.equal(fs.existsSync(path.join(dataDir, 'projects')), false, '打开清单和预览均不写平台同步状态或缓存文件');
  assert.equal(preview.body.queried, 2, '两个本地条目关联同一个云端表，仅查询一次');
  assert.deepEqual(preview.body.changes, [
    { path: 'Datas/A.xlsx', name: '甲', before: { cloudDir: '旧目录', cloudFile: '旧名称' }, after: { cloudDir: '新目录', cloudFile: '新名称' } },
    { path: 'Datas/B.xlsx', name: '乙', before: { cloudDir: null, cloudFile: null }, after: { cloudDir: '新目录', cloudFile: '新名称' } }
  ]);
  assert.deepEqual(preview.body.failures, [{ path: 'Datas/C.xlsx', name: '丙', error: '无法访问' }]);

  const apply = (p, id) => request('/cloud-paths/apply', { previewId: p.body.previewId }, id);
  assert.equal((await apply(preview, projects[1].id)).status, 409);
  assert.equal(fs.readFileSync(path.join(projects[1].dir, 'filelist.json'), 'utf8'), ORIGINAL);

  const applied = await apply(preview);
  assert.equal(applied.status, 200);
  assert.equal(applied.body.updated, 2);
  const written = fs.readFileSync(filelistPath, 'utf8');
  const expected = ORIGINAL.replace('"旧目录"', '"新目录"').replace('"旧名称"', '"新名称"')
    .replace('"mergeCells": true', '"mergeCells": true,\r\n\t\t"cloudDir": "新目录",\r\n\t\t"cloudFile": "新名称"');
  assert.equal(written, expected);
  assert.equal((await apply(preview)).status, 409, '已应用的预览不可重放');

  fs.writeFileSync(filelistPath, ORIGINAL);
  const beforeBindingChange = await request('/cloud-paths', {});
  const rebound = ORIGINAL.replace(SHARED, 'another-sheet-id-for-test');
  fs.writeFileSync(filelistPath, rebound);
  assert.equal((await apply(beforeBindingChange)).status, 409);
  assert.equal(fs.readFileSync(filelistPath, 'utf8'), rebound);

  fs.writeFileSync(filelistPath, ORIGINAL);
  const beforeMappingChange = await request('/cloud-paths', {});
  fs.writeFileSync(configPath, JSON.stringify({ ...config, cloudRoot: { folderId: 'other-folder', local: 'Datas' } }));
  assert.equal((await apply(beforeMappingChange)).status, 409);
  assert.equal(fs.readFileSync(filelistPath, 'utf8'), ORIGINAL);

  const beforeFileChange = await request('/cloud-paths', {});
  const newFile = path.join(projects[0].dir, 'different-filelist.json');
  fs.writeFileSync(newFile, ORIGINAL);
  fs.writeFileSync(configPath, JSON.stringify({ ...config, filelist: 'different-filelist.json' }));
  assert.equal((await apply(beforeFileChange)).status, 409);
  assert.equal(fs.readFileSync(newFile, 'utf8'), ORIGINAL);
});
