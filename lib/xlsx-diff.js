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

// 把连续的「只在本地 / 只在云端」配对成「修改」，剩下的才算新增 / 删除
function toChanges(L, C, ops) {
  const changes = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].op === 'same') { k++; continue; }
    const locals = [];
    const clouds = [];
    while (k < ops.length && ops[k].op !== 'same') {
      if (ops[k].op === 'local') locals.push(ops[k].i); else clouds.push(ops[k].j);
      k++;
    }
    const pairs = Math.min(locals.length, clouds.length);
    for (let p = 0; p < pairs; p++) {
      const cells = cellChanges(L[locals[p]], C[clouds[p]]);
      if (cells.length) changes.push({ type: 'modified', localRow: locals[p] + 1, cloudRow: clouds[p] + 1, cells });
    }
    for (let p = pairs; p < locals.length; p++) changes.push({ type: 'local_only', localRow: locals[p] + 1, values: L[locals[p]] });
    for (let p = pairs; p < clouds.length; p++) changes.push({ type: 'cloud_only', cloudRow: clouds[p] + 1, values: C[clouds[p]] });
  }
  return changes;
}

// 列标题：Luban 表头行（首列为 ##var）优先，否则用第一行
function headerOf(rows) {
  const idx = rows.slice(0, 10).findIndex(r => /^##var$/i.test(String(r[0] || '').trim()));
  return (rows[idx >= 0 ? idx : 0] || []).slice();
}

function diffSheet(name, L, C, maxChanges) {
  const changes = toChanges(L, C, alignRows(L, C));
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
    truncated: changes.length > maxChanges
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
      sheets.push({ name: ls.name, status: 'local_only', localRows: ls.rows.length, cloudRows: 0, header: headerOf(ls.rows), stats: null, changes: [], truncated: false });
      continue;
    }
    sheets.push(diffSheet(ls.name, ls.rows, cs.rows, maxChanges));
  }
  for (const cs of cloud) {
    if (seen.has(cs.name)) continue;
    sheets.push({ name: cs.name, status: 'cloud_only', localRows: 0, cloudRows: cs.rows.length, header: headerOf(cs.rows), stats: null, changes: [], truncated: false });
  }
  return { identical: sheets.every(s => s.status === 'same'), sheets };
}

module.exports = { diffWorkbooks, alignRows, sameCell, headerOf };
