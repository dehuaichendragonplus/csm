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
function headerOf(rows) {
  const idx = rows.slice(0, 10).findIndex(r => /^##var$/i.test(String(r[0] || '').trim()));
  return (rows[idx >= 0 ? idx : 0] || []).slice();
}

function diffSheet(name, L, C, maxChanges) {
  const entries = alignedEntries(L, C, alignRows(L, C));
  const changes = toChanges(L, C, entries);
  const stats = { modified: 0, localOnly: 0, cloudOnly: 0, cells: 0 };
  for (const ch of changes) {
    if (ch.type === 'modified') { stats.modified++; stats.cells += ch.cells.length; }
    else if (ch.type === 'local_only') stats.localOnly++;
    else stats.cloudOnly++;
  }
  return {
    name,
    status: changes.length ? 'changed' : 'same',
    localRows: L.length,
    cloudRows: C.length,
    header: headerOf(L.length ? L : C),
    stats,
    changes: changes.slice(0, maxChanges),
    truncated: changes.length > maxChanges,
    view: changes.length ? buildView(L, C, entries) : null
  };
}

// 整个工作表只在一边：全部行当作新增 / 删除展示
function oneSideSheet(name, rows, side) {
  const entries = rows.map((_, x) => (side === 'local' ? { k: 'L', i: x } : { k: 'C', j: x }));
  const L = side === 'local' ? rows : [];
  const C = side === 'local' ? [] : rows;
  return {
    name,
    status: side === 'local' ? 'local_only' : 'cloud_only',
    localRows: L.length,
    cloudRows: C.length,
    header: headerOf(rows),
    stats: null,
    changes: [],
    truncated: false,
    view: buildView(L, C, entries, { full: true })
  };
}

/** local / cloud：readWorkbook 的结果。返回 { identical, sheets: [...] }，工作表按本地顺序，云端新增的排在后面 */
function diffWorkbooks(local, cloud, { maxChanges = DEFAULT_MAX_CHANGES } = {}) {
  const cloudByName = new Map(cloud.map(s => [s.name, s]));
  const seen = new Set();
  const sheets = [];
  for (const ls of local) {
    seen.add(ls.name);
    const cs = cloudByName.get(ls.name);
    if (!cs) {
      sheets.push(oneSideSheet(ls.name, ls.rows, 'local'));
      continue;
    }
    sheets.push(diffSheet(ls.name, ls.rows, cs.rows, maxChanges));
  }
  for (const cs of cloud) {
    if (seen.has(cs.name)) continue;
    sheets.push(oneSideSheet(cs.name, cs.rows, 'cloud'));
  }
  return { identical: sheets.every(s => s.status === 'same'), sheets };
}

module.exports = { diffWorkbooks, alignRows, alignedEntries, buildView, sameCell, headerOf };
