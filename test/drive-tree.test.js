'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { matchOne, inferRoot, alignDir, pickSamples, createRootResolver } = require('../lib/drive-tree');

const MX11 = { id: 'f-mx11', name: 'MX11' };
const DATA = { id: 'f-data', name: 'Data' };
const ACT = { id: 'f-act', name: 'Activity' };
const SHOP = { id: 'f-shop', name: 'Shop' };
const OTHER = { id: 'f-other', name: 'Other' };

test('matchOne 本地目录与云端链尾部最长匹配', () => {
  assert.deepStrictEqual(matchOne('Datas/Activity/A.xlsx', [MX11, DATA, ACT]), {
    root: DATA, rootPath: ['MX11', 'Data'], localRoot: 'Datas', matched: 1
  });
  // 直接放在根目录下的表
  assert.strictEqual(matchOne('Datas/Notification.xlsx', [MX11, DATA]).root, DATA);
  assert.strictEqual(matchOne('Datas/Notification.xlsx', [MX11, DATA]).localRoot, 'Datas');
  // 大小写不敏感
  assert.strictEqual(matchOne('Datas/activity/A.xlsx', [MX11, DATA, ACT]).matched, 1);
  assert.strictEqual(matchOne('A.xlsx', []), null);
});

test('inferRoot 投票选出一致的云端根与本地根', () => {
  const root = inferRoot([
    { path: 'Datas/Activity/A.xlsx', chain: [MX11, DATA, ACT] },
    { path: 'Datas/Shop/B.xlsx', chain: [MX11, DATA, SHOP] },
    { path: 'Datas/C.xlsx', chain: [MX11, DATA] },
    { path: 'Datas/Weird/D.xlsx', chain: [OTHER] }, // 噪声
    { path: 'Datas/E.xlsx', chain: [] }
  ]);
  assert.deepStrictEqual(root, { rootId: 'f-data', rootName: 'Data', rootPath: 'MX11 / Data', localRoot: 'Datas', votes: 3, sampled: 5 });
  assert.strictEqual(inferRoot([]), null);
});

test('alignDir 按相对云端根目录的子目录放置', () => {
  const root = { rootId: 'f-data', localRoot: 'Datas' };
  assert.deepStrictEqual(alignDir([MX11, DATA, ACT], root), { dir: 'Datas/Activity', aligned: true, mode: 'mapped', cloudDir: 'Data / Activity' });
  assert.strictEqual(alignDir([MX11, DATA], root).dir, 'Datas');
  assert.strictEqual(alignDir([MX11, DATA, ACT, { id: 'x', name: 'Sub Dir' }], root).dir, 'Datas/Activity/Sub_Dir');
});

test('alignDir 没有映射时按云端所在文件夹放到 Datas 下；不在根目录下时提示', () => {
  assert.deepStrictEqual(alignDir([MX11, DATA, ACT], null), { dir: 'Datas/Activity', aligned: false, mode: 'parent', cloudDir: 'MX11 / Data / Activity' });
  assert.strictEqual(alignDir([], null).dir, 'Datas');
  const r = alignDir([OTHER, SHOP], { rootId: 'f-data', localRoot: 'Datas' });
  assert.strictEqual(r.mode, 'outside');
  assert.strictEqual(r.dir, 'Datas/Shop');
});

test('pickSamples 均匀抽样且跳过无 ID 条目', () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({ path: `p${i}.xlsx`, spreadsheetId: i === 0 ? '' : `id${i}` }));
  const s = pickSamples(entries, 8);
  assert.strictEqual(s.length, 8);
  assert.ok(s.every(e => e.spreadsheetId));
});

test('createRootResolver 缓存成功结果，推断失败不缓存', async () => {
  let calls = 0;
  const tree = { parentChain: async () => { calls++; return [MX11, DATA, ACT]; } };
  const r = createRootResolver();
  const entries = [{ path: 'Datas/Activity/A.xlsx', spreadsheetId: 'a' }];
  const a = await r.resolve({ projectId: 'p', cacheKey: 'k', entries, tree });
  await r.resolve({ projectId: 'p', cacheKey: 'k', entries, tree });
  assert.strictEqual(a.rootId, 'f-data');
  assert.strictEqual(a.source, 'inferred');
  assert.strictEqual(calls, 1);
  assert.strictEqual(await r.resolve({ projectId: 'q', cacheKey: 'k', entries: [], tree }), null);
  await r.resolve({ projectId: 'q', cacheKey: 'k', entries, tree });
  assert.strictEqual(calls, 2, '空清单的 null 结果没有被缓存');
});

test('createTreeClient.parentChain：命中文件夹缓存时按层级组装完整路径', async () => {
  const { createTreeClient } = require('../lib/drive-tree');
  const FOLDER = 'application/vnd.google-apps.folder';
  const folders = {
    root: { id: 'root', name: 'MX11', mimeType: FOLDER },
    data: { id: 'data', name: 'Data', mimeType: FOLDER, parents: ['root'] },
    item: { id: 'item', name: 'Item', mimeType: FOLDER, parents: ['data'] }
  };
  const cache = new Map(Object.values(folders).map(f => [f.id, Promise.resolve(f)]));
  const client = createTreeClient(null, cache); // 全部命中缓存，不会发起 Drive 请求
  const sheet = { id: 's1', name: 'ItemGlobal', mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['item'] };
  const chain = await client.parentChain('s1', sheet);
  assert.deepStrictEqual(chain.map(f => f.name), ['MX11', 'Data', 'Item']);
});
