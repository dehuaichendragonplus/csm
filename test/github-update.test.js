const { test } = require('node:test');
const assert = require('node:assert');
const { checkGitHubUpdate, selectMacDmgAsset, selectWinExeAsset, parseReleasesAtom, getGitHubHeaders } = require('../lib/github-update');

const asset = (name, size = 100) => ({ name, size, browser_download_url: `https://github.com/o/r/releases/download/v1.2.0/${name}` });
const ASSETS = [
  asset('CSM-1.2.0-mac-arm64.dmg', 111),
  asset('CSM-1.2.0-mac-arm64.dmg.blockmap'),
  asset('CSM-1.2.0-mac-x64.dmg', 222),
  asset('CSM-Setup-1.2.0-x64.exe', 333),
  asset('CSM-Setup-1.2.0-x64.exe.blockmap'),
  asset('latest.yml')
];

function jsonResp(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function textResp(status, text) {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text };
}
const HEADERS = { Accept: 'application/vnd.github+json' };

test('selectMacDmgAsset：按架构精确匹配，不误选另一架构', () => {
  assert.strictEqual(selectMacDmgAsset(ASSETS, 'arm64').name, 'CSM-1.2.0-mac-arm64.dmg');
  assert.strictEqual(selectMacDmgAsset(ASSETS, 'x64').name, 'CSM-1.2.0-mac-x64.dmg');
  // 只有另一架构的包 → null
  assert.strictEqual(selectMacDmgAsset([asset('CSM-1.2.0-mac-x64.dmg')], 'arm64'), null);
  assert.strictEqual(selectMacDmgAsset([asset('CSM-1.2.0-mac-arm64.dmg')], 'x64'), null);
  // 通用命名作为兜底；带架构的精确匹配优先
  assert.strictEqual(selectMacDmgAsset([asset('CSM-1.2.0-universal.dmg')], 'arm64').name, 'CSM-1.2.0-universal.dmg');
  assert.strictEqual(selectMacDmgAsset([asset('CSM-1.2.0.dmg'), asset('CSM-1.2.0-arm64.dmg')], 'arm64').name, 'CSM-1.2.0-arm64.dmg');
  assert.strictEqual(selectMacDmgAsset([asset('CSM_1.2.0_x64.dmg')], 'x64').name, 'CSM_1.2.0_x64.dmg');
  // 忽略 blockmap
  assert.strictEqual(selectMacDmgAsset([asset('CSM-1.2.0-mac-arm64.dmg.blockmap')], 'arm64'), null);
});

test('selectWinExeAsset：挑 Setup exe，忽略 blockmap', () => {
  assert.strictEqual(selectWinExeAsset(ASSETS, 'x64').name, 'CSM-Setup-1.2.0-x64.exe');
  assert.strictEqual(selectWinExeAsset([asset('a.exe.blockmap')], 'x64'), null);
});

test('checkGitHubUpdate：API 正常返回新版本（macOS arm64）', async () => {
  const urls = [];
  const r = await checkGitHubUpdate({
    current: '1.1.3', platform: 'darwin', arch: 'arm64', headers: HEADERS,
    fetchImpl: async url => {
      urls.push(url);
      return jsonResp(200, { tag_name: 'v1.2.0', html_url: 'https://github.com/o/r/releases/tag/v1.2.0', body: '修复若干问题', published_at: '2026-11-11T00:00:00Z', assets: ASSETS });
    }
  });
  assert.deepStrictEqual(urls, ['https://api.github.com/repos/dehuaichendragonplus/csm/releases/latest']);
  assert.strictEqual(r.hasUpdate, true);
  assert.strictEqual(r.latest, '1.2.0');
  assert.strictEqual(r.tag, 'v1.2.0');
  assert.strictEqual(r.notes, '修复若干问题');
  assert.strictEqual(r.fileName, 'CSM-1.2.0-mac-arm64.dmg');
  assert.strictEqual(r.assetSize, 111);
  assert.match(r.downloadUrl, /mac-arm64\.dmg$/);
  assert.strictEqual(r.assetInferred, false);
  assert.strictEqual(r.source, 'github');
});

test('checkGitHubUpdate：已是最新 / Windows 匹配 exe', async () => {
  const fetchImpl = async () => jsonResp(200, { tag_name: '1.2.0', html_url: 'h', body: '', assets: ASSETS });
  const same = await checkGitHubUpdate({ current: '1.2.0', platform: 'darwin', arch: 'x64', headers: HEADERS, fetchImpl });
  assert.strictEqual(same.hasUpdate, false);
  const win = await checkGitHubUpdate({ current: '1.1.0', platform: 'win32', arch: 'x64', headers: HEADERS, fetchImpl });
  assert.strictEqual(win.hasUpdate, true);
  assert.strictEqual(win.fileName, 'CSM-Setup-1.2.0-x64.exe');
});

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes from csm</title>
  <entry>
    <id>tag:github.com,2008:Repository/1/v1.3.0</id>
    <updated>2026-11-10T08:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/dehuaichendragonplus/csm/releases/tag/v1.3.0"/>
    <title>CSM 1.3.0</title>
    <content type="html">&lt;ul&gt;&lt;li&gt;新增自动更新&lt;/li&gt;&lt;li&gt;修复 A &amp;amp; B&lt;/li&gt;&lt;/ul&gt;</content>
  </entry>
  <entry>
    <link rel="alternate" type="text/html" href="https://github.com/dehuaichendragonplus/csm/releases/tag/v1.2.0"/>
    <title>v1.2.0</title>
  </entry>
</feed>`;

test('parseReleasesAtom：取第一个 entry，tag 从链接解析', () => {
  const e = parseReleasesAtom(ATOM);
  assert.strictEqual(e.tag, 'v1.3.0');
  assert.strictEqual(e.title, 'CSM 1.3.0');
  assert.strictEqual(e.updated, '2026-11-10T08:00:00Z');
  assert.match(e.notes, /新增自动更新/);
  assert.match(e.notes, /A & B/);
  assert.strictEqual(parseReleasesAtom('<feed></feed>'), null);
});

test('checkGitHubUpdate：API 403 限流时降级 Atom，并推断 macOS dmg 直链', async () => {
  const urls = [];
  const r = await checkGitHubUpdate({
    current: '1.1.3', platform: 'darwin', arch: 'x64', headers: HEADERS,
    fetchImpl: async url => {
      urls.push(url);
      return url.includes('api.github.com') ? jsonResp(403, { message: 'rate limit' }) : textResp(200, ATOM);
    }
  });
  assert.strictEqual(urls.length, 2);
  assert.match(urls[1], /releases\.atom$/);
  assert.strictEqual(r.source, 'github-atom');
  assert.strictEqual(r.latest, '1.3.0');
  assert.strictEqual(r.hasUpdate, true);
  assert.strictEqual(r.assetInferred, true);
  assert.strictEqual(r.fileName, 'CSM-1.3.0-mac-x64.dmg');
  assert.strictEqual(r.downloadUrl, 'https://github.com/dehuaichendragonplus/csm/releases/download/v1.3.0/CSM-1.3.0-mac-x64.dmg');
  assert.match(r.htmlUrl, /releases\/tag\/v1\.3\.0$/);
});

test('checkGitHubUpdate：网络异常降级 Atom；两者都失败返回 error 而不抛', async () => {
  const viaAtom = await checkGitHubUpdate({
    current: '1.1.3', platform: 'win32', arch: 'x64', headers: HEADERS,
    fetchImpl: async url => { if (url.includes('api.github.com')) throw new Error('ECONNRESET'); return textResp(200, ATOM); }
  });
  assert.strictEqual(viaAtom.hasUpdate, true);
  assert.strictEqual(viaAtom.downloadUrl, null); // Windows 不推断直链，交给 electron-updater

  const failed = await checkGitHubUpdate({
    current: '1.1.3', platform: 'darwin', arch: 'arm64', headers: HEADERS,
    fetchImpl: async () => { throw new Error('ENOTFOUND github.com'); }
  });
  assert.strictEqual(failed.hasUpdate, false);
  assert.strictEqual(failed.configured, true);
  assert.match(failed.error, /无法连接 GitHub/);
  assert.match(failed.error, /ENOTFOUND/);
});

test('checkGitHubUpdate：仓库还没有 Release（API 404 + Atom 空）', async () => {
  const r = await checkGitHubUpdate({
    current: '1.1.3', platform: 'darwin', arch: 'arm64', headers: HEADERS,
    fetchImpl: async url => url.includes('api.github.com') ? jsonResp(404, {}) : textResp(200, '<feed></feed>')
  });
  assert.strictEqual(r.hasUpdate, false);
  assert.match(r.error, /还没有发布任何 Release/);
  assert.doesNotMatch(r.error, /无法连接/);
  assert.strictEqual(r.noRelease, true);
});

test('getGitHubHeaders：环境变量 token 优先，其次 gh CLI，失败静默', async () => {
  const h1 = await getGitHubHeaders({ env: { GITHUB_TOKEN: 't1' }, readGhToken: async () => 'gh' });
  assert.strictEqual(h1.Authorization, 'Bearer t1');
  const h2 = await getGitHubHeaders({ env: {}, readGhToken: async () => 'gh' });
  assert.strictEqual(h2.Authorization, 'Bearer gh');
  const h3 = await getGitHubHeaders({ env: {}, readGhToken: async () => { throw new Error('no gh'); } });
  assert.strictEqual(h3.Authorization, undefined);
  assert.strictEqual(h3['User-Agent'], 'CSM-Desktop');
});
