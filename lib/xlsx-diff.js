'use strict';
// 本地 / 云端两份工作簿的差异：按工作表比较，行先对齐（识别插入 / 删除的行），再列出改动的单元格。
const { colName } = require('./xlsx-reader');

const DEFAULT_MAX_CHANGES = 300;  // 每个工作表最多返回多少条行改动（统计数字仍是全部）
const LCS_LIMIT = 4_000_000;      // 中间不同段 n*m 超过这个规模时不做行对齐，按行号逐行比较

const rowKey = row => row.join('\u0001');

function sameCell(a, b) {
  if (a === b) return true;
  if (a === '' || b === '') return false;
  const x = Number(a);
  const y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  return false;
}

function cellChanges(a, b) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let c = 0; c < n; c++) {
    const x = a[c] ?? '';
    const y = b[c] ?? '';
    if (!sameCell(x, y)) out.push({ col: c, colName: colName(c), local: x, cloud: y });
  }
  return out;
}

// 行对齐：去掉相同的头尾后对中间段做 LCS；返回操作序列 [{ op: 'same'|'local'|'cloud', i, j }]
function alignRows(L, C) {
  const lk = L.map(rowKey);
  const ck = C.map(rowKey);
  let pre = 0;
  while (pre < lk.length && pre < ck.length && lk[pre] === ck[pre]) pre++;
  let suf = 0;
  while (suf < lk.length - pre && suf < ck.length - pre && lk[lk.length - 1 - suf] === ck[ck.length - 1 - suf]) suf++;
  const ops = [];
  for (let k = 0; k < pre; k++) ops.push({ op: 'same', i: k, j: k });
  const n = lk.length - pre - suf;
  const m = ck.length - pre - suf;
  if (n > 0 || m > 0) {
    if (n > 0 && m > 0 && n * m <= LCS_LIMIT) {
      // dp[i][j] = L[pre+i..] 与 C[pre+j..] 的 LCS 长度（一维数组按行存放）
      const w = m + 1;
      const dp = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i * w + j] = lk[pre + i] === ck[pre + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && lk[pre + i] === ck[pre + j]) { ops.push({ op: 'same', i: pre + i, j: pre + j }); i++; j++; }
        else if (j < m && (i >= n || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) { ops.push({ op: 'cloud', j: pre + j }); j++; }
        else { ops.push({ op: 'local', i: pre + i }); i++; }
      }
    } else {
      // 规模太大：按位置逐行配对
      for (let k = 0; k < Math.max(n, m); k++) {
        if (k < n) ops.push({ op: 'local', i: pre + k });
        if (k < m) ops.push({ op: 'cloud', j: pre + k });
      }
    }
  }
  for (let k = suf; k > 0; k--) ops.push({ op: 'same', i: lk.length - k, j: ck.length - k });
  return ops;
}

// 对齐后的逐行序列：把连续的「只在本地 / 只在云端」配对成「修改」，剩下的才算新增 / 删除
// 返回 [{ k: '='|'~'|'L'|'C', i?, j?, cells? }]（i / j 为 0 起的行下标；'~' 带改动的单元格）
function alignedEntries(L, C, ops) {
  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].op === 'same') { out.push({ k: '=', i: ops[k].i, j: ops[k].j }); k++; continue; }
    const locals = [];
    const clouds = [];
    while (k < ops.length && ops[k].op !== 'same') {
      if (ops[k].op === 'local') locals.push(ops[k].i); else clouds.push(ops[k].j);
      k++;
    }
    for (const [a, b] of pairBlock(L, C, locals, clouds)) {
      if (a != null && b != null) {
        const cells = cellChanges(L[a], C[b]);
        out.push(cells.length ? { k: '~', i: a, j: b, cells } : { k: '=', i: a, j: b });
      } else if (a != null) out.push({ k: 'L', i: a });
      else out.push({ k: 'C', j: b });
    }
  }
  return out;
}

// 两行的相似度：非空位置里相同单元格的占比
function similarity(a, b) {
  let union = 0;
  let same = 0;
  for (let c = 0, n = Math.max(a.length, b.length); c < n; c++) {
    const x = a[c] ?? '';
    const y = b[c] ?? '';
    if (x === '' && y === '') continue;
    union++;
    if (sameCell(x, y)) same++;
  }
  return union ? same / union : 1;
}

const PAIR_MIN_SIMILARITY = 0.5;
const PAIR_DP_LIMIT = 40_000;

// 一段连续的不同行里，哪些本地行和云端行算「同一行被修改」。返回按位置排好的 [[i|null, j|null]]
// 行数相同 → 按位置一一配对（最常见：原地改了几行）；行数不同 → 按相似度做保序匹配，配不上的算新增 / 删除
function pairBlock(L, C, locals, clouds) {
  const n = locals.length;
  const m = clouds.length;
  if (n === m || n === 0 || m === 0 || n * m > PAIR_DP_LIMIT) {
    const out = [];
    const p = Math.min(n, m);
    for (let x = 0; x < p; x++) out.push([locals[x], clouds[x]]);
    for (let x = p; x < n; x++) out.push([locals[x], null]);
    for (let x = p; x < m; x++) out.push([null, clouds[x]]);
    return out;
  }
  const w = m + 1;
  const sim = new Float64Array(n * m);
  for (let a = 0; a < n; a++) for (let b = 0; b < m; b++) sim[a * m + b] = similarity(L[locals[a]], C[clouds[b]]);
  const dp = new Float64Array((n + 1) * w);
  for (let a = n - 1; a >= 0; a--) {
    for (let b = m - 1; b >= 0; b--) {
      const s = sim[a * m + b];
      let best = Math.max(dp[(a + 1) * w + b], dp[a * w + b + 1]);
      if (s >= PAIR_MIN_SIMILARITY) best = Math.max(best, s + dp[(a + 1) * w + b + 1]);
      dp[a * w + b] = best;
    }
  }
  const out = [];
  let a = 0;
  let b = 0;
  while (a < n || b < m) {
    if (a < n && b < m) {
      const s = sim[a * m + b];
      if (s >= PAIR_MIN_SIMILARITY && dp[a * w + b] === s + dp[(a + 1) * w + b + 1]) { out.push([locals[a], clouds[b]]); a++; b++; continue; }
      if (dp[(a + 1) * w + b] >= dp[a * w + b + 1]) { out.push([locals[a], null]); a++; } else { out.push([null, clouds[b]]); b++; }
    } else if (a < n) { out.push([locals[a], null]); a++; } else { out.push([null, clouds[b]]); b++; }
  }
  return out;
}

function toChanges(L, C, entries) {
  const changes = [];
  for (const e of entries) {
    if (e.k === '~') changes.push({ type: 'modified', localRow: e.i + 1, cloudRow: e.j + 1, cells: e.cells });
    else if (e.k === 'L') changes.push({ type: 'local_only', localRow: e.i + 1, values: L[e.i] });
    else if (e.k === 'C') changes.push({ type: 'cloud_only', cloudRow: e.j + 1, values: C[e.j] });
  }
  return changes;
}

// ---------- 给前端逐行对照视图用的数据（类似 git diff 的 hunk，带上下文行） ----------
const VIEW_FULL_CELLS = 300_000;   // 工作表两边单元格总数不超过这个规模时，相同行也全部带上（前端可展开）
const VIEW_MAX_CHANGES = 2000;     // 每个工作表最多带多少条改动行
const VIEW_CONTEXT = 3;            // 不能全部带上时，每处改动前后保留的相同行数

const cellCount = rows => rows.reduce((n, r) => n + r.length, 0);

/**
 * entries：alignedEntries 的结果。返回 { full, cols, rows, truncated }
 *   rows：[{ k:'=', l, c, v } | { k:'~', l, c, lv, cv, d:[列下标] } | { k:'L', l, v } | { k:'C', c, v } | { k:'gap', n, l, c }]
 *   l / c 为 1 起的行号；full=false 时，远离改动的相同行折叠成 gap（前端无法展开）
 */
function buildView(L, C, entries, { full = cellCount(L) + cellCount(C) <= VIEW_FULL_CELLS, maxChanges = VIEW_MAX_CHANGES, context = VIEW_CONTEXT } = {}) {
  const keep = new Uint8Array(entries.length);
  if (full) keep.fill(1);
  else {
    entries.forEach((e, x) => {
      if (e.k === '=') return;
      for (let y = Math.max(0, x - context); y <= Math.min(entries.length - 1, x + context); y++) keep[y] = 1;
    });
  }
  const rows = [];
  let cols = 0;
  let changes = 0;
  let truncated = false;
  let gap = null;
  const width = r => { if (r && r.length > cols) cols = r.length; };
  for (let x = 0; x < entries.length; x++) {
    const e = entries[x];
    if (e.k !== '=') {
      if (changes >= maxChanges) { truncated = true; break; }
      changes++;
    }
    if (!keep[x]) {
      if (!gap) { gap = { k: 'gap', n: 0, l: e.i + 1, c: e.j + 1 }; rows.push(gap); }
      gap.n++;
      continue;
    }
    gap = null;
    if (e.k === '=') { rows.push({ k: '=', l: e.i + 1, c: e.j + 1, v: L[e.i] }); width(L[e.i]); }
    else if (e.k === '~') { rows.push({ k: '~', l: e.i + 1, c: e.j + 1, lv: L[e.i], cv: C[e.j], d: e.cells.map(c => c.col) }); width(L[e.i]); width(C[e.j]); }
    else if (e.k === 'L') { rows.push({ k: 'L', l: e.i + 1, v: L[e.i] }); width(L[e.i]); }
    else { rows.push({ k: 'C', c: e.j + 1, v: C[e.j] }); width(C[e.j]); }
  }
  return { full, cols, rows, truncated };
}

// 列标题：Luban 表头行（首列为 ##var）优先，否则用第一行
function headerIndex(rows) {
  return Math.max(0, rows.slice(0, 10).findIndex(r => /^##var$/i.test(String(r[0] || '').trim())));
}
function headerOf(rows) {
  return (rows[headerIndex(rows)] || []).slice();
}

const keyName = value => String(value || '').trim().toLowerCase().replace(/_/g, '');

function keySpec(rows, fields) {
  const header = headerOf(rows);
  const names = header.map(keyName);
  if (!Array.isArray(fields) || !fields.length) {
    fields = ['id', 'productid', 'shopid', 'key'].filter(name => names.includes(name)).slice(0, 1);
  }
  const cols = fields.map(field => {
    const name = keyName(field);
    return name && names.indexOf(name) === names.lastIndexOf(name) ? names.indexOf(name) : -1;
  });
  const start = headerIndex(rows) + 1;
  let first = start;
  if (names[0] === '##var') {
    while (first < rows.length && /^##/.test(String(rows[first][0] || '').trim())) first++;
  }
  return { cols: cols.length && cols.every(c => c >= 0) ? cols : [], fields: fields.map(keyName), first };
}

function keyIndex(rows, { cols, first }) {
  if (!cols.length) return null;
  const index = new Map();
  for (let i = first; i < rows.length; i++) {
    const parts = cols.map(c => String(rows[i][c] ?? ''));
    if (parts.some(part => !part.trim())) return null;
    const key = JSON.stringify(parts);
    if (index.has(key)) return null;
    index.set(key, i);
  }
  return index;
}

function pairedEntry(L, C, i, j) {
  const cells = cellChanges(L[i], C[j]);
  return cells.length ? { k: '~', i, j, cells } : { k: '=', i, j };
}

function compareRows(L, C, fields, local = keySpec(L, fields), cloud = keySpec(C, fields)) {
  const left = keyIndex(L, local);
  const right = keyIndex(C, cloud);
  // 两侧必须使用同一组列，且每侧的主键都非空、唯一。
  if (!left || !right || String(local.cols) !== String(cloud.cols)
      || String(local.fields) !== String(cloud.fields)) {
    return { local, cloud, entries: alignedEntries(L, C, alignRows(L, C)), alignedByKey: false, orderChanged: false };
  }

  const prefixL = L.slice(0, local.first);
  const prefixC = C.slice(0, cloud.first);
  const entries = alignedEntries(prefixL, prefixC, alignRows(prefixL, prefixC));
  const cloudInserts = new Map();
  let next = null;
  for (const [key, j] of [...right].reverse()) {
    if (left.has(key)) next = key;
    else {
      if (!cloudInserts.has(next)) cloudInserts.set(next, []);
      cloudInserts.get(next).push({ k: 'C', j });
    }
  }
  const appendCloudInserts = key => {
    for (const e of (cloudInserts.get(key) || []).reverse()) entries.push(e);
  };
  let last = -1;
  let orderChanged = false;
  for (const [key, i] of left) {
    const j = right.get(key);
    if (j === undefined) entries.push({ k: 'L', i });
    else {
      if (j < last) orderChanged = true;
      last = j;
      appendCloudInserts(key);
      entries.push(pairedEntry(L, C, i, j));
    }
  }
  appendCloudInserts(null);
  return { local, cloud, entries, alignedByKey: true, orderChanged };
}

// 有内容的列（任一单元格非空）。返回列下标集合
function filledCols(rows) {
  const set = new Set();
  for (const row of rows) for (let c = 0; c < row.length; c++) if (String(row[c] ?? '').trim() !== '') set.add(c);
  return set;
}

// 只在一侧有内容的列：另一侧整列都是空的（新增 / 删除了一整列）。返回 { local: [列下标], cloud: [列下标] }
function oneSideCols(L, C) {
  const l = filledCols(L);
  const c = filledCols(C);
  return {
    local: [...l].filter(x => !c.has(x)).sort((a, b) => a - b),
    cloud: [...c].filter(x => !l.has(x)).sort((a, b) => a - b)
  };
}

function diffSheet(name, L, C, { maxChanges, view, fields }) {
  const { local, cloud, entries, alignedByKey, orderChanged } = compareRows(L, C, fields);
  const stats = { modified: 0, localOnly: 0, cloudOnly: 0, cells: 0 };
  const sampleEntries = [];
  for (const e of entries) {
    if (e.k === '~') {
      stats.modified++;
      stats.cells += e.cells.length;
      if (sampleEntries.length < 5 && e.i >= local.first && e.j >= cloud.first) sampleEntries.push(e);
    } else if (e.k === 'L') stats.localOnly++;
    else if (e.k === 'C') stats.cloudOnly++;
  }
  const total = stats.modified + stats.localOnly + stats.cloudOnly;
  const header = headerOf(L.length ? L : C);
  const cloudHeader = headerOf(C);
  // 一侧整列为空的列。表头取有这列的一侧（本地没有的列，本地表头自然也是空的）
  const onlyCols = oneSideCols(L, C);
  onlyCols.cloud.forEach(c => { if (!header[c] && cloudHeader[c]) header[c] = cloudHeader[c]; });
  return {
    name,
    status: total || orderChanged ? 'changed' : 'same',
    localRows: L.length,
    cloudRows: C.length,
    header,
    onlyCols,
    alignedByKey,
    orderChanged,
    stats,
    changes: toChanges(L, C, entries.filter(e => e.k !== '=').slice(0, maxChanges)),
    truncated: total > maxChanges,
    samples: sampleEntries.flatMap(e => e.cells.slice(0, 3).map(cell => ({
      sheet: name,
      record: alignedByKey ? local.cols.map(c => shortValue(L[e.i][c])).join(' / ') : `本地第 ${e.i + 1} 行`,
      field: shortValue(header[cell.col] || cell.colName),
      local: shortValue(cell.local),
      cloud: shortValue(cell.cloud)
    }))).slice(0, 5),
    view: view && (total || orderChanged) ? buildView(L, C, entries) : null
  };
}

function shortValue(value) {
  const text = String(value ?? '');
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

// 整个工作表只在一边：全部行当作新增 / 删除展示
function oneSideSheet(name, rows, side, view) {
  const L = side === 'local' ? rows : [];
  const C = side === 'cloud' ? rows : [];
  return {
    name,
    status: side === 'local' ? 'local_only' : 'cloud_only',
    localRows: L.length,
    cloudRows: C.length,
    header: headerOf(rows),
    stats: null,
    changes: [],
    truncated: false,
    view: view ? buildView(L, C, rows.map((_, x) => side === 'local' ? { k: 'L', i: x } : { k: 'C', j: x }), { full: true }) : null
  };
}

function workbookPairs(local, cloud) {
  const byName = new Map(cloud.map(s => [s.name, s.rows]));
  const pairs = local.map(sheet => {
    const pair = { name: sheet.name, L: sheet.rows, C: byName.get(sheet.name) };
    byName.delete(sheet.name);
    return pair;
  });
  for (const [name, C] of byName) pairs.push({ name, C });
  return pairs;
}

function diffWorkbooks(local, cloud, { maxChanges = DEFAULT_MAX_CHANGES, view = true, keys } = {}) {
  const sheets = workbookPairs(local, cloud).map(({ name, L, C }) => {
    if (!C) return oneSideSheet(name, L, 'local', view);
    if (!L) return oneSideSheet(name, C, 'cloud', view);
    return diffSheet(name, L, C, { maxChanges, view, fields: keys?.[name] });
  });
  return { identical: sheets.every(s => s.status === 'same'), sheets };
}

function summarizeDiff(diff) {
  const summary = { added: 0, changed: 0, removed: 0, reordered: 0, sheetsAdded: 0, sheetsRemoved: 0, samples: [] };
  for (const sheet of diff.sheets) {
    if (sheet.stats) {
      summary.added += sheet.stats.cloudOnly;
      summary.changed += sheet.stats.modified;
      summary.removed += sheet.stats.localOnly;
      if (sheet.orderChanged) summary.reordered++;
      for (const sample of sheet.samples) if (summary.samples.length < 5) summary.samples.push(sample);
    } else if (sheet.status === 'local_only') {
      summary.removed += sheet.localRows;
      summary.sheetsRemoved++;
    } else if (sheet.status === 'cloud_only') {
      summary.added += sheet.cloudRows;
      summary.sheetsAdded++;
    }
  }
  return summary;
}

function findRecords(local, cloud, record, keys) {
  const query = record.trim().toLowerCase();
  if (!query) return [];
  const matches = (row, spec, i) => {
    if (!row || i < spec.first) return false;
    const parts = spec.cols.map(c => String(row[c] ?? '').trim().toLowerCase());
    return parts.includes(query) || parts.join(' / ') === query;
  };
  const found = [];
  for (const { name, L = [], C = [] } of workbookPairs(local, cloud)) {
    const fields = keys?.[name];
    const localKey = keySpec(L, fields);
    const cloudKey = keySpec(C, fields);
    const localHits = new Set();
    const cloudHits = new Set();
    if (localKey.cols.length) L.forEach((row, i) => { if (matches(row, localKey, i)) localHits.add(i); });
    if (cloudKey.cols.length) C.forEach((row, j) => { if (matches(row, cloudKey, j)) cloudHits.add(j); });
    if (!localHits.size && !cloudHits.size) continue;
    const result = compareRows(L, C, fields, localKey, cloudKey);
    const hits = result.alignedByKey
      ? result.entries.filter(e => localHits.has(e.i) || cloudHits.has(e.j))
      : [...Array.from(localHits, i => ({ k: 'L', i })), ...Array.from(cloudHits, j => ({ k: 'C', j }))];
    found.push({
      name,
      status: 'changed',
      alignedByKey: result.alignedByKey,
      header: headerOf(L.length ? L : C),
      matches: hits.length,
      view: buildView(L, C, hits.slice(0, VIEW_MAX_CHANGES), { full: true }),
    });
  }
  return found;
}

module.exports = { oneSideCols, diffWorkbooks, summarizeDiff, findRecords, alignRows, alignedEntries, buildView, sameCell, headerOf };
