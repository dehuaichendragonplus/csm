'use strict';
// 公式保护：云端表里有公式（典型：IMPORTRANGE 镜像主表）时，上传不能用 Drive 整表替换，
// 否则公式会被本地的「值」冲掉。这里是纯逻辑：识别云端公式区，并按单元格生成「只写非公式格」的写入计划。
// 本地 xlsx 是从云端导出的计算结果，不含公式，所以公式区的本地差异只能报告、不能写入（应改公式的数据源）。
const { colName, normalizeNumber } = require('./xlsx-reader');

// 会向下/向右溢出一片区域的函数；命中则保护整列（宽度见 spillWidth），否则只保护公式所在单元格
const SPILL_RE = /IMPORTRANGE|IMPORTDATA|IMPORTXML|IMPORTHTML|IMPORTFEED|ARRAYFORMULA|QUERY|FILTER|SORT|UNIQUE|TRANSPOSE|SPLIT|FLATTEN|SEQUENCE|\{/i;

const SAMPLE_LIMIT = 20;

function colIndexOf(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function a1(row, col) { return `${colName(col)}${row + 1}`; }

// 云端单元格的「有效值」转成与 xlsx-reader 一致的字符串（数字规范化、布尔 TRUE/FALSE）
function effectiveToString(ev) {
  if (!ev) return '';
  if (ev.stringValue != null) return ev.stringValue;
  if (ev.numberValue != null) return normalizeNumber(String(ev.numberValue));
  if (ev.boolValue != null) return ev.boolValue ? 'TRUE' : 'FALSE';
  if (ev.errorValue) return ev.errorValue.message || '#ERROR!';
  return '';
}

function sheetCells(sheet) {
  // spreadsheets.get(includeGridData) 的 data 可能分块：每块有 startRow / startColumn 偏移
  const cells = new Map(); // "r,c" → { formula, effective }
  for (const block of sheet.data || []) {
    const r0 = block.startRow || 0;
    const c0 = block.startColumn || 0;
    (block.rowData || []).forEach((row, i) => {
      (row.values || []).forEach((cell, j) => {
        if (!cell) return;
        const uev = cell.userEnteredValue || null;
        const formula = uev && uev.formulaValue ? uev.formulaValue : null;
        const hasUser = !!(uev && (uev.formulaValue != null || uev.stringValue != null || uev.numberValue != null || uev.boolValue != null));
        const effective = effectiveToString(cell.effectiveValue);
        const error = !!(cell.effectiveValue && cell.effectiveValue.errorValue);
        if (!formula && !hasUser && effective === '') return;
        cells.set(`${r0 + i},${c0 + j}`, { formula, hasUser, effective, error });
      });
    });
  }
  return cells;
}

/** 这个表有没有公式（探测阶段的结果也走这里）：返回 [{ row, col, formula }] */
function findFormulas(sheet) {
  const out = [];
  for (const [key, cell] of sheetCells(sheet)) {
    if (!cell.formula) continue;
    const [row, col] = key.split(',').map(Number);
    out.push({ row, col, formula: cell.formula });
  }
  return out.sort((a, b) => a.row - b.row || a.col - b.col);
}

// 公式引用的 A1 区域宽度：IMPORTRANGE("…", "Main!R2:R9000") → 1；解析不出来返回 null
function rangeWidth(formula) {
  const m = /["']\s*(?:[^"'!]+!)?\$?([A-Z]{1,3})\$?\d*\s*:\s*\$?([A-Z]{1,3})\$?\d*\s*["']/.exec(formula);
  if (!m) return null;
  return Math.abs(colIndexOf(m[2]) - colIndexOf(m[1])) + 1;
}

/**
 * 云端公式保护区：[{ row, col, width, spill, formula }]，spill=true 表示保护 (row..末行) × (col..col+width-1)，否则只保护单元格
 */
function protectedRegions(sheet) {
  const cells = sheetCells(sheet);
  const regions = [];
  for (const f of findFormulas(sheet)) {
    const below = cells.get(`${f.row + 1},${f.col}`);
    const spill = SPILL_RE.test(f.formula) || !!(below && !below.hasUser && below.effective !== '');
    let width = 1;
    if (spill) {
      width = rangeWidth(f.formula);
      if (!width) {
        // 解析不出范围：看公式行右边连续多少格是「计算出来的」（有值但不是用户输入）
        width = 1;
        while (true) {
          const right = cells.get(`${f.row},${f.col + width}`);
          if (right && !right.hasUser && right.effective !== '') width++; else break;
        }
      }
    }
    // 公式自身报错（#REF! 等：IMPORTRANGE 未授权 / 源表打不开 / 被挡住溢出）时镜像看不到源数据，无法核对
    const anchor = cells.get(`${f.row},${f.col}`);
    regions.push({ row: f.row, col: f.col, width, spill, formula: f.formula, error: !!(anchor && anchor.error) });
  }
  return regions;
}

function isProtected(regions, row, col) {
  for (const g of regions) {
    if (g.spill) {
      if (row >= g.row && col >= g.col && col < g.col + g.width) return true;
    } else if (row === g.row && col === g.col) return true;
  }
  return false;
}

/**
 * 单个工作表的写入计划
 * localRows：xlsx-reader 读出的 string[][]；cloudSheet：spreadsheets.get 的单个 sheet（含 data）
 * 返回 { writes: [{row,col,value}], skipped: { count, samples }, regions }
 */
function planSheet(localRows, cloudSheet) {
  const regions = protectedRegions(cloudSheet);
  const cells = sheetCells(cloudSheet);
  const cloudAt = (r, c) => { const x = cells.get(`${r},${c}`); return x ? x.effective : ''; };

  let maxRow = localRows.length;
  let maxCol = 0;
  for (const row of localRows) maxCol = Math.max(maxCol, row.length);
  for (const key of cells.keys()) {
    const [r, c] = key.split(',').map(Number);
    if (cells.get(key).effective !== '') { maxRow = Math.max(maxRow, r + 1); maxCol = Math.max(maxCol, c + 1); }
  }

  const writes = [];
  const skipped = { count: 0, samples: [] };
  const protectedDiffs = []; // 公式区里本地与云端不同的格：{ row, col, local, cloud, region }
  for (let r = 0; r < maxRow; r++) {
    const lrow = localRows[r] || [];
    for (let c = 0; c < maxCol; c++) {
      const local = lrow[c] == null ? '' : String(lrow[c]);
      const cloud = cloudAt(r, c);
      if (local === cloud) continue;
      const region = regionAt(regions, r, c);
      if (region) {
        skipped.count++;
        if (skipped.samples.length < SAMPLE_LIMIT) skipped.samples.push({ cell: a1(r, c), local, cloud });
        protectedDiffs.push({ row: r, col: c, local, cloud, region });
        continue;
      }
      writes.push({ row: r, col: c, value: local });
    }
  }
  return { writes, skipped, regions, protectedDiffs };
}

function regionAt(regions, row, col) {
  for (const g of regions) {
    if (g.spill) {
      if (row >= g.row && col >= g.col && col < g.col + g.width) return g;
    } else if (row === g.row && col === g.col) return g;
  }
  return null;
}

// ---------- 写回源表（IMPORTRANGE 镜像区） ----------
// 镜像区里写值会挡住公式的溢出（#REF!），所以「本地全部覆盖云端」对镜像区的含义只能是：改它的数据源。
// IMPORTRANGE("<url 或 id>", "Main!R2:R9000") 锚在镜像表 (row,col) → 镜像格 (r,c) 对应源表 Main 的 (2-1 + r-row, R + c-col)

/** 解析 IMPORTRANGE：{ sourceId, sheet|null, startRow, startCol, endRow|null, endCol }（行列都是 0 起）；不是可映射的形式返回 null */
function parseImportRange(formula) {
  const m = /^\s*=\s*IMPORTRANGE\s*\(\s*"([^"]+)"\s*[,;]\s*"([^"]+)"\s*\)\s*$/i.exec(formula || '');
  if (!m) return null;
  const idm = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(m[1]);
  const sourceId = idm ? idm[1] : (/^[a-zA-Z0-9_-]{20,}$/.test(m[1].trim()) ? m[1].trim() : null);
  if (!sourceId) return null;
  let ref = m[2].trim();
  let sheet = null;
  const bang = ref.lastIndexOf('!');
  if (bang >= 0) { sheet = ref.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'"); ref = ref.slice(bang + 1); }
  const rm = /^\$?([A-Z]{1,3})\$?(\d+)?(?::\$?([A-Z]{1,3})\$?(\d+)?)?$/i.exec(ref);
  if (!rm) return null;
  const startCol = colIndexOf(rm[1]);
  const startRow = rm[2] ? parseInt(rm[2], 10) - 1 : 0;
  const endCol = rm[3] ? colIndexOf(rm[3]) : startCol;
  const endRow = rm[4] ? parseInt(rm[4], 10) - 1 : (rm[3] ? null : startRow);
  return { sourceId, sheet, startRow, startCol, endRow, endCol };
}

/**
 * 把各工作表公式区的差异映射到源表。plans = planWorkbook().plans
 * 返回 {
 *   sources: Map(sourceId → Map(sheet|'' → Map("r,c" → { row, col, value, expect, from: [mirror 位置] }))),
 *   derived: [{ sheet, cell, local, cloud, formula }]   —— 其他公式（VLOOKUP 等）算出来的格：源数据改了会自动跟着变
 *   blocked: [{ sheet, cell, local, cloud, reason }]    —— 映射不了的差异（超出公式引用的范围 / 两张镜像表要写同一个源格但值不同）
 * }
 * expect = 镜像当前看到的值（写源表前用来判断源表是不是被别人改过）
 */
function planWriteThrough(plans) {
  const sources = new Map();
  const derived = [];
  const blocked = [];
  for (const p of plans) {
    for (const d of p.protectedDiffs || []) {
      const ir = d.region.spill ? parseImportRange(d.region.formula) : null;
      const where = { sheet: p.title, cell: a1(d.row, d.col), local: d.local, cloud: d.cloud };
      if (!ir) { derived.push({ ...where, formula: d.region.formula }); continue; }
      if (d.region.error) { blocked.push({ ...where, reason: 'mirror_error' }); continue; }
      const row = ir.startRow + (d.row - d.region.row);
      const col = ir.startCol + (d.col - d.region.col);
      if ((ir.endRow != null && row > ir.endRow) || col > ir.endCol) { blocked.push({ ...where, reason: 'outside_range' }); continue; }
      if (!sources.has(ir.sourceId)) sources.set(ir.sourceId, new Map());
      const bySheet = sources.get(ir.sourceId);
      const sk = ir.sheet || '';
      if (!bySheet.has(sk)) bySheet.set(sk, new Map());
      const cells = bySheet.get(sk);
      const key = `${row},${col}`;
      const prev = cells.get(key);
      if (prev) {
        if (prev.value !== d.local) { prev.conflict = true; blocked.push({ ...where, reason: 'conflict', other: prev.from[0] }); }
        else prev.from.push(`${p.title}!${a1(d.row, d.col)}`);
        continue;
      }
      cells.set(key, { row, col, value: d.local, expect: d.cloud, from: [`${p.title}!${a1(d.row, d.col)}`] });
    }
  }
  // 有冲突的源格一律不写
  for (const bySheet of sources.values()) {
    for (const cells of bySheet.values()) {
      for (const [k, c] of cells) {
        if (c.conflict) { cells.delete(k); blocked.push({ sheet: c.from[0].split('!')[0], cell: c.from[0].split('!')[1], local: c.value, cloud: c.expect, reason: 'conflict' }); }
      }
    }
  }
  return { sources, derived, blocked };
}

function countWriteThrough(sources) {
  let n = 0;
  for (const bySheet of sources.values()) for (const cells of bySheet.values()) n += cells.size;
  return n;
}

// 写入值：以 = 开头的文本加撇号，避免被当成公式（USER_ENTERED 会解析）
function toInputValue(v) {
  return typeof v === 'string' && v.startsWith('=') ? `'${v}` : v;
}

function quoteSheet(title) { return `'${String(title).replace(/'/g, "''")}'`; }

/** 把写入合并成「同一行连续列」的 values.batchUpdate data 项 */
function toValueRanges(title, writes) {
  const sorted = [...writes].sort((a, b) => a.row - b.row || a.col - b.col);
  const out = [];
  let cur = null;
  for (const w of sorted) {
    if (cur && w.row === cur.row && w.col === cur.endCol + 1) {
      cur.values.push(toInputValue(w.value));
      cur.endCol = w.col;
    } else {
      if (cur) out.push(cur);
      cur = { row: w.row, startCol: w.col, endCol: w.col, values: [toInputValue(w.value)] };
    }
  }
  if (cur) out.push(cur);
  return out.map(g => ({
    range: `${quoteSheet(title)}!${a1(g.row, g.startCol)}:${a1(g.row, g.endCol)}`,
    values: [g.values]
  }));
}

/**
 * 整个工作簿的计划：localSheets = [{name, rows}]，cloudSheets = spreadsheets.get 的 sheets
 * 只处理两边都有的工作表；只在一边存在的记入 localOnly / cloudOnly（不动）
 */
function planWorkbook(localSheets, cloudSheets) {
  const cloudByTitle = new Map(cloudSheets.map(s => [s.properties.title, s]));
  const plans = [];
  const localOnly = [];
  const seen = new Set();
  for (const ls of localSheets) {
    const cs = cloudByTitle.get(ls.name);
    if (!cs) { localOnly.push(ls.name); continue; }
    seen.add(ls.name);
    const p = planSheet(ls.rows, cs);
    plans.push({ title: ls.name, sheetId: cs.properties.sheetId, grid: cs.properties.gridProperties || {}, ...p });
  }
  const cloudOnly = cloudSheets.map(s => s.properties.title).filter(t => !seen.has(t));
  const skippedCount = plans.reduce((n, p) => n + p.skipped.count, 0);
  const written = plans.reduce((n, p) => n + p.writes.length, 0);
  const formulaSheets = plans.filter(p => p.regions.length).map(p => ({ name: p.title, formulas: p.regions.length }));
  return { plans, localOnly, cloudOnly, skippedCount, written, formulaSheets };
}

module.exports = {
  findFormulas, protectedRegions, isProtected, planSheet, planWorkbook, toValueRanges,
  parseImportRange, planWriteThrough, countWriteThrough, sheetCells,
  effectiveToString, rangeWidth, a1, quoteSheet, SAMPLE_LIMIT
};
