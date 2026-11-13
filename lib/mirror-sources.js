'use strict';
// IMPORTRANGE 镜像表的「有效版本」。
// 源表被修改时，镜像表（=IMPORTRANGE(源表, ...)）的内容会跟着变，但镜像表自身的 Drive modifiedTime 不变。
// 只看镜像表自身时间，别人改了源表 CSM 仍显示「已同步」、导出缓存也还是旧内容。
// 这里把镜像表的有效版本定义为 max(自身 modifiedTime, 各源表 modifiedTime)，状态判断 / 导出缓存键 / 核对键 / 上传冲突检测都用它。
//
// 源表 id 靠探测公式得到（Sheets API，只拉公式），结果按「镜像表自身修改时间」持久化：
// 镜像表自身没改过，公式就没变，不重新探测；改公式必然改自身时间，届时再探测一次。
const fs = require('node:fs');
const path = require('node:path');
const guard = require('./formula-guard');

// 嵌套写法（IFERROR(IMPORTRANGE(...))、QUERY(IMPORTRANGE(...), ...)）parseImportRange 解析不了，只为拿源表 id 时按这个兜底
const IMPORT_RE = /IMPORTRANGE\s*\(\s*("([^"]*)"|[^,;)]*)/gi;

function sourceIdOf(arg) {
  const s = String(arg || '').trim();
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(s);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : null;
}

/**
 * 从探测结果（spreadsheets.get 的 sheets，字段见 drive-api 的 PROBE_FIELDS）里找出 IMPORTRANGE 的源表。
 * 返回 { sources: [源表 id]（去重、排序）, unresolved: 源表 id 写成单元格引用等、解析不出的 IMPORTRANGE 个数 }
 */
function extractImportSources(sheets, selfId = null) {
  const ids = new Set();
  let unresolved = 0;
  for (const sheet of sheets || []) {
    for (const f of guard.findFormulas(sheet)) {
      const exact = guard.parseImportRange(f.formula);
      if (exact) { ids.add(exact.sourceId); continue; }
      IMPORT_RE.lastIndex = 0;
      let m;
      while ((m = IMPORT_RE.exec(f.formula))) {
        const id = m[2] != null ? sourceIdOf(m[2]) : null;
        if (id) ids.add(id); else unresolved++;
      }
    }
  }
  if (selfId) ids.delete(selfId); // 引用自身的 IMPORTRANGE 不是外部源
  return { sources: [...ids].sort(), unresolved };
}

// ---------- 持久化：{ [镜像表 id]: { probedFor, probedAt, sources, unresolved, probeError? } } ----------
function createSourceStore(filePath) {
  let data = null;
  const load = () => {
    if (data) return data;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) { data = {}; }
    return data;
  };
  return {
    get: id => load()[id] || null,
    set(id, rec) { load()[id] = rec; },
    delete(id) { delete load()[id]; },
    save() {
      if (!filePath || !data) return;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, filePath);
      } catch (err) { console.error('[csm] write mirror-sources failed:', err.message); }
    }
  };
}

/** 内存版（测试 / 不需要落盘时用） */
function memoryStore(initial = {}) {
  const data = { ...initial };
  return { get: id => data[id] || null, set(id, rec) { data[id] = rec; }, delete(id) { delete data[id]; }, save() {}, data };
}

// ---------- 有效版本 ----------
const SOURCE_ERROR_TEXT = { forbidden: '没有源表的访问权限', not_found: '找不到源表或没有权限', rate_limited: '查询源表被限流' };

/**
 * own：镜像表自身的云端信息（getModifiedTimes 的单项）；rec：持久化的探测记录；times：Map(源表 id → 云端信息)
 * 不是镜像表（或自身查询失败）原样返回 own；是镜像表时返回：
 * { ...own, modifiedTime: 有效版本, ownModifiedTime, sources: [{ id, name, modifiedTime, error }],
 *   changedVia: { id, name } | null（有效版本来自哪张源表）, sourceCheck: 'ok' | 'failed', sourceWarning }
 * 源表查询失败的不参与取 max（全部失败时退回只用自身时间），并给出 sourceCheck='failed' 供界面提示「无法检查源表更新」
 */
function effectiveInfo(own, rec, times) {
  if (!own || own.error || !own.modifiedTime) return own;
  const ids = (rec && rec.sources) || [];
  const unresolved = (rec && rec.unresolved) || 0;
  if (!ids.length && !unresolved) return own;
  let modifiedTime = own.modifiedTime;
  let modifiedBy = own.modifiedBy || null;
  let changedVia = null;
  const sources = [];
  const problems = [];
  for (const id of ids) {
    const t = times.get(id);
    if (!t || t.error || !t.modifiedTime) {
      const reason = (t && t.error) || 'unknown';
      sources.push({ id, name: (t && t.name) || null, modifiedTime: null, error: reason });
      problems.push(SOURCE_ERROR_TEXT[reason] || `源表查询失败（${reason}）`);
      continue;
    }
    sources.push({ id, name: t.name || null, modifiedTime: t.modifiedTime, modifiedBy: t.modifiedBy || null, error: null });
    if (t.modifiedTime > modifiedTime) {
      modifiedTime = t.modifiedTime;
      modifiedBy = t.modifiedBy || null;
      changedVia = { id, name: t.name || null };
    }
  }
  if (unresolved) problems.push(`${unresolved} 个 IMPORTRANGE 的源表地址无法识别（如写成了单元格引用）`);
  return {
    ...own,
    modifiedTime,
    modifiedBy,
    ownModifiedTime: own.modifiedTime,
    ownModifiedBy: own.modifiedBy || null,
    sources,
    changedVia,
    sourceCheck: problems.length ? 'failed' : 'ok',
    sourceWarning: problems.length ? `无法检查源表更新：${[...new Set(problems)].join('；')}` : null
  };
}

function describeProbeError(err) {
  const s = err && (err.code != null ? err.code : err.response && err.response.status);
  const n = Number(s);
  return n === 403 ? 'forbidden' : n === 404 ? 'not_found' : n === 400 ? 'unsupported' : (err && err.message) || 'unknown';
}

// 这些错误换个时间再试也一样（非原生表格 / 无权限 / 已删除）：记下来，镜像表自身没改就不再探测
const PERMANENT_PROBE_ERRORS = new Set(['forbidden', 'not_found', 'unsupported']);

const DEFAULT_PROBE_CONCURRENCY = 3; // Sheets API 每用户每分钟读请求有上限，探测并发不宜高

// 改公式一定会改镜像表自身的修改时间，所以自身时间没变就沿用上次的探测结果
function needsProbe(rec, own) {
  if (!own || own.error || !own.modifiedTime) return false;
  return !rec || rec.probedFor !== own.modifiedTime;
}

// 同一张表的探测在多次刷新之间去重（上次超出等待时间、还在后台跑的探测直接复用）
const inflightProbes = new WeakMap(); // store → Map(id → Promise)

/**
 * 查询一批表的云端信息，镜像表换成有效版本。返回 Map(id → info)（与 getModifiedTimes 同形，镜像表多出 sources 等字段）。
 * - getTimes(ids)：批量查修改时间（drive-api 的 getModifiedTimes），镜像表和已知源表放进同一批
 * - probe(id)：拉公式（spreadsheets.get + PROBE_FIELDS），返回 sheets 数组；失败抛错
 * - store：探测记录持久化（createSourceStore / memoryStore）
 * - budgetMs：探测最多等多久（表多、首次探测时不能拖住刷新）；超时的探测在后台继续，结果写入 store 供下次使用，
 *   本次先沿用旧记录（没有旧记录就当作普通表）。null = 等全部探测完成
 */
async function resolveCloudInfos(ids, { getTimes, probe, store, budgetMs = null, concurrency = DEFAULT_PROBE_CONCURRENCY, now = Date.now(), onProbed } = {}) {
  const want = [...new Set((ids || []).filter(Boolean))];
  const known = new Set();
  for (const id of want) for (const s of (store.get(id) || {}).sources || []) known.add(s);
  const times = await getTimes([...new Set([...want, ...known])]);

  // 自身时间变了 / 从没探测过 → 探测公式
  const todo = want.filter(id => needsProbe(store.get(id), times.get(id)));
  if (todo.length && probe) {
    if (!inflightProbes.has(store)) inflightProbes.set(store, new Map());
    const inflight = inflightProbes.get(store);
    let changed = false;
    const queue = [...todo];
    const runOne = id => {
      if (!inflight.has(id)) inflight.set(id, probeOne(id).finally(() => inflight.delete(id)));
      return inflight.get(id);
    };
    const probeOne = async id => {
      const own = times.get(id);
      try {
        const found = extractImportSources(await probe(id), id);
        store.set(id, { probedFor: own.modifiedTime, probedAt: new Date(now).toISOString(), ...found });
        changed = true;
      } catch (err) {
        const reason = describeProbeError(err);
        // 临时故障（限流 / 网络）不记，沿用旧记录，下次刷新再探测
        if (PERMANENT_PROBE_ERRORS.has(reason)) {
          store.set(id, { probedFor: own.modifiedTime, probedAt: new Date(now).toISOString(), sources: [], unresolved: 0, probeError: reason });
          changed = true;
        }
      }
    };
    const worker = async () => { while (queue.length) await runOne(queue.shift()); };
    const all = Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker)).then(() => {
      if (changed) store.save();
      if (onProbed) onProbed();
    });
    if (budgetMs == null) await all;
    else {
      let timer;
      await Promise.race([all, new Promise(r => { timer = setTimeout(r, budgetMs); })]);
      clearTimeout(timer);
      if (changed) store.save(); // 已完成的先落盘；剩下的完成后还会再存一次
    }
  }

  // 新发现的源表还没查过时间：补查一批
  const missing = new Set();
  for (const id of want) for (const s of (store.get(id) || {}).sources || []) if (!times.has(s)) missing.add(s);
  if (missing.size) {
    let extra;
    try { extra = await getTimes([...missing]); } catch (_) { extra = new Map(); }
    for (const s of missing) times.set(s, extra.get(s) || { modifiedTime: null, name: null, modifiedBy: null, error: 'unknown' });
  }

  const out = new Map();
  for (const id of want) {
    const own = times.get(id);
    if (own) out.set(id, effectiveInfo(own, store.get(id), times));
  }
  return out;
}

module.exports = {
  extractImportSources, effectiveInfo, resolveCloudInfos, createSourceStore, memoryStore, needsProbe
};
