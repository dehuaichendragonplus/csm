'use strict';
// 云端目录 ↔ 本地目录对齐：
// 例：云端 MX11 / Data / Activity / DeepBoard2 ↔ 本地 Datas/Activity/DeepBoard2.xlsx
// 用清单里已有条目反推「云端根目录（Data）对应本地哪个目录（Datas）」，
// 新表按它在云端根目录下的子目录，放到本地对应的子目录。
const { google } = require('googleapis');

const DEFAULT_LOCAL_ROOT = 'Datas';
const MAX_DEPTH = 15;
const SAMPLE_SIZE = 12;

// ---------- Drive 访问（带文件夹缓存） ----------

function createTreeClient(oauth2Client, folderCache = new Map()) {
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  async function getMeta(id) {
    if (folderCache.has(id)) return folderCache.get(id);
    const p = drive.files
      .get({ fileId: id, fields: 'id, name, parents, mimeType', supportsAllDrives: true })
      .then(r => r.data)
      .catch(() => null); // 无权限的上级目录：链条到此为止
    folderCache.set(id, p);
    const meta = await p;
    if (!meta) folderCache.delete(id); // 失败不缓存，下次重试
    return meta;
  }

  // 返回从最顶层到直接父目录的链：[{ id, name }, ...]
  async function parentChain(fileId, fileMeta) {
    const meta = fileMeta || await getMeta(fileId);
    const chain = [];
    let cur = meta;
    for (let i = 0; i < MAX_DEPTH && cur && cur.parents && cur.parents.length; i++) {
      cur = await getMeta(cur.parents[0]);
      if (!cur) break;
      chain.unshift({ id: cur.id, name: cur.name });
    }
    return chain;
  }

  return { getMeta, parentChain };
}

// ---------- 纯函数：推断与对齐 ----------

function dirParts(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
  parts.pop(); // 去掉文件名
  return parts;
}

const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// 单个条目：本地目录与云端链尾部做最长匹配，匹配段之前的本地部分即本地根，云端链对应位置即云端根
function matchOne(localPath, chain) {
  const local = dirParts(localPath);
  let k = 0;
  while (k < local.length && k < chain.length && same(local[local.length - 1 - k], chain[chain.length - 1 - k].name)) k++;
  const rootIdx = chain.length - 1 - k;
  if (rootIdx < 0) return null;
  const localRoot = local.slice(0, local.length - k).join('/');
  return { root: chain[rootIdx], rootPath: chain.slice(0, rootIdx + 1).map(f => f.name), localRoot, matched: k };
}

// samples: [{ path, chain }]；投票选出最一致的（云端根, 本地根）组合
function inferRoot(samples) {
  const votes = new Map();
  for (const s of samples) {
    if (!s.chain || !s.chain.length) continue;
    const m = matchOne(s.path, s.chain);
    if (!m) continue;
    const key = `${m.root.id}\n${m.localRoot}`;
    const v = votes.get(key) || { ...m, count: 0, matchedSum: 0 };
    v.count++;
    v.matchedSum += m.matched;
    votes.set(key, v);
  }
  let best = null;
  for (const v of votes.values()) {
    // 票数优先；同票时优先「有子目录真正匹配上」的组合
    if (!best || v.count > best.count || (v.count === best.count && v.matchedSum > best.matchedSum)) best = v;
  }
  if (!best) return null;
  return {
    rootId: best.root.id,
    rootName: best.root.name,
    rootPath: best.rootPath.join(' / '),
    localRoot: best.localRoot,
    votes: best.count,
    sampled: samples.length
  };
}

// 新文件的父目录链 → 本地目录。
// mode：mapped = 在映射的云端根目录下，按相对目录对齐；
//       parent = 没有可用映射（未配置且推断不出），按云端所在文件夹放到 Datas/<文件夹名>；
//       outside = 有映射但文件不在映射的云端根目录下，同样按所在文件夹放，并提示人工确认
function alignDir(chain, root) {
  const cloudDir = chain.map(f => f.name).join(' / ');
  const parentDir = base => {
    const parent = chain.length ? sanitizeSegment(chain[chain.length - 1].name) : '';
    return [base, parent].filter(Boolean).join('/');
  };
  if (!root) return { dir: parentDir(DEFAULT_LOCAL_ROOT), aligned: false, mode: 'parent', cloudDir };
  const idx = chain.findIndex(f => f.id === root.rootId);
  if (idx < 0) return { dir: parentDir(root.localRoot), aligned: false, mode: 'outside', cloudDir };
  const sub = chain.slice(idx + 1).map(f => sanitizeSegment(f.name)).filter(Boolean);
  return {
    dir: [root.localRoot, ...sub].filter(Boolean).join('/'),
    aligned: true,
    mode: 'mapped',
    cloudDir: chain.slice(idx).map(f => f.name).join(' / ')
  };
}

function sanitizeSegment(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').replace(/^\.+/, '').trim();
}

// 均匀抽样：只抽 Datas 等目录下的条目，避免几十个请求
function pickSamples(entries, n = SAMPLE_SIZE) {
  const valid = entries.filter(e => e && e.spreadsheetId && typeof e.path === 'string');
  if (valid.length <= n) return valid;
  const step = valid.length / n;
  return Array.from({ length: n }, (_, i) => valid[Math.floor(i * step)]);
}

// ---------- 带缓存的项目级推断 ----------

function createRootResolver() {
  const cache = new Map(); // projectId -> { key, promise }

  async function resolve({ projectId, cacheKey, entries, tree }) {
    const hit = cache.get(projectId);
    if (hit && hit.key === cacheKey) return hit.promise;
    const promise = (async () => {
      // 并发查询；文件夹元信息在 tree 里按 Promise 缓存，同一文件夹只会请求一次
      const picked = pickSamples(entries);
      const samples = (await Promise.all(picked.map(async e => {
        try { return { path: e.path, chain: await tree.parentChain(e.spreadsheetId) }; } catch (_) { return null; }
      }))).filter(Boolean);
      const root = inferRoot(samples);
      return root ? { ...root, source: 'inferred' } : null;
    })();
    cache.set(projectId, { key: cacheKey, promise });
    // 失败或推断不出（如清单为空）都不缓存，清单有了条目后下次能重新推断
    promise.then(r => { if (!r) cache.delete(projectId); }, () => cache.delete(projectId));
    return promise;
  }

  return { resolve, invalidate: id => cache.delete(id) };
}

module.exports = {
  DEFAULT_LOCAL_ROOT,
  createTreeClient,
  createRootResolver,
  matchOne,
  inferRoot,
  alignDir,
  pickSamples
};
