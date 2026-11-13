'use strict';
// 把差异窗口里编辑后的整张表写回 xlsx：在原文件基础上只重写被编辑工作表的 <sheetData>，其余部件原样保留。
//   - 原样保留：样式、列宽、其它工作表、sharedStrings（新值一律写成 inlineStr，不动共享字符串表）
//   - 行带上来源行号 src（原文件第几行，1 起；null = 从另一侧复制过来的新行）：
//     值没变的单元格整段沿用原 XML（样式 / 公式 / 类型都不变），改过的单元格沿用原样式、写入新值
//   - 行被插入 / 删除导致行号变化时：含合并单元格的表拒绝写（合并区域会错位），挪了位置的公式改成写值
//   - 删除 xl/calcChain.xml（公式计算链引用旧单元格位置，留着 Excel 会提示修复；打开时自动重建）
const zlib = require('node:zlib');
const { readWorkbook, decodeXml, colName, colIndex } = require('./xlsx-reader');

// ---------- zip（读出原始条目，写回时未改动的条目直接拷贝压缩数据） ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 zip 目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('xlsx 的 zip 目录已损坏');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lh = localOffset;
    if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error(`xlsx 内文件头损坏：${name}`);
    const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
    entries.push({ name, method, crc, size, raw: buf.subarray(start, start + compSize) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryText(e) {
  if (e.method === 0) return e.raw.toString('utf8');
  if (e.method === 8) return zlib.inflateRawSync(e.raw).toString('utf8');
  throw new Error(`不支持的压缩方式 ${e.method}：${e.name}`);
}

function setText(e, text) {
  const data = Buffer.from(text, 'utf8');
  e.method = 8;
  e.raw = zlib.deflateRawSync(data);
  e.crc = crc32(data);
  e.size = data.length;
}

function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(e.method, 8);
    lh.writeUInt32LE(e.crc, 14); lh.writeUInt32LE(e.raw.length, 18); lh.writeUInt32LE(e.size, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, e.raw);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(e.method, 10);
    ch.writeUInt32LE(e.crc, 16); ch.writeUInt32LE(e.raw.length, 20); ch.writeUInt32LE(e.size, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + e.raw.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---------- 工作表 xml ----------
const escXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // xml 1.0 不允许的控制字符按 OOXML 规则转义成 _xHHHH_
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ch => `_x${ch.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}_`);

// 像数字的文本写成数值单元格；前导 0（"007"）、过长、带空格等保持文本，避免被改写
const NUMERIC = /^-?(0|[1-9]\d{0,14})(\.\d+)?([eE][-+]?\d+)?$/;

function sheetFileOf(entriesByName, sheetName) {
  const wb = entryText(entriesByName.get('xl/workbook.xml'));
  const rels = entryText(entriesByName.get('xl/_rels/workbook.xml.rels') || { method: 0, raw: Buffer.from('') });
  const relMap = new Map();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[1])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(m[1])?.[1];
    if (id) relMap.set(id, decodeXml(target));
  }
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = decodeXml(/\bname="([^"]*)"/.exec(m[1])?.[1] || '');
    if (name !== sheetName) continue;
    const rid = /\s\w+:id="([^"]*)"/.exec(m[1])?.[1];   // r:id（前缀可能不同）；sheetId 不带冒号，不会误配
    const t = String(relMap.get(rid) || '').replace(/\\/g, '/');
    if (!t) return null;
    if (t.startsWith('/')) return t.slice(1);
    const parts = ['xl'];
    for (const seg of t.split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
    return parts.join('/');
  }
  return null;
}

// 原表每一行的属性与单元格原始 xml：rows.get(行号 1 起) = { attrs, cells: Map(列下标 → { xml, attrs, formula }) }
function parseRows(sheetData) {
  const rows = new Map();
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let next = 1;
  let m;
  while ((m = rowRe.exec(sheetData))) {
    const rn = Number(/\br="(\d+)"/.exec(m[1])?.[1]) || next;
    next = rn + 1;
    const cells = new Map();
    let col = 0;
    let cm;
    cellRe.lastIndex = 0;
    while (m[2] && (cm = cellRe.exec(m[2]))) {
      const ref = /\br="([A-Z]+)\d*"/.exec(cm[1]);
      const c = ref ? colIndex(ref[1]) : col;
      col = c + 1;
      cells.set(c, { xml: cm[0], attrs: cm[1], formula: /<f\b/.test(cm[2] || '') });
    }
    rows.set(rn, { attrs: m[1], cells });
  }
  return rows;
}

const stripAttr = (attrs, name) => attrs.replace(new RegExp(`\\s${name}="[^"]*"`, 'g'), '');
const styleOf = attrs => /\ss="(\d+)"/.exec(attrs)?.[1];

// 单元格是文本还是数值：沿用原单元格的类型（配置表里 "1"、"13" 这类文本型数字不能被改成数值，
// 导表工具对 arraynumber 等列按文本切分）；没有原单元格时由调用方按同列上方最近的单元格推断
const kindOf = attrs => (/\st="(s|inlineStr|str)"/.test(attrs) ? 'text' : /\st="(b|e|d)"/.test(attrs) ? 'other' : 'num');

function cellXml(ref, value, style, kind) {
  const s = style != null ? ` s="${style}"` : '';
  if (value === '') return style != null ? `<c r="${ref}"${s}/>` : '';
  if (kind !== 'text' && NUMERIC.test(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escXml(value)}</t></is></c>`;
}

/**
 * 重写一个工作表。rows：[{ src: 原行号(1 起) | null, v: string[] }]，按新顺序排列。
 * orig：readWorkbook 读出的该表原值（判断单元格是否改过）。返回 { xml, warnings }
 */
function rewriteSheet(xml, rows, orig, sheetName) {
  const sd = /<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml);
  if (!sd) throw new Error(`工作表「${sheetName}」结构异常（缺少 sheetData）`);
  const original = parseRows(sd[1] || '');
  const moved = rows.some((r, k) => r.src !== k + 1) || rows.length < orig.length;
  const warnings = [];
  if (moved && /<mergeCell\b/.test(xml)) {
    throw new Error(`工作表「${sheetName}」有合并单元格，插入 / 删除行后合并区域会错位，暂不支持；请只改单元格，或在 Excel / 云端里调整行`);
  }
  // 同列上方最近的原单元格类型（最多往上找 200 行）
  const kindAbove = (c, from) => {
    for (let r = from; r >= 1 && r > from - 200; r--) {
      const cell = original.get(r)?.cells.get(c);
      if (cell) return kindOf(cell.attrs);
    }
    return null;
  };
  let maxCol = 0;
  let lastRow = 0;
  let lastSrc = 0;
  const out = [];
  rows.forEach((row, k) => {
    if (row.src != null) lastSrc = row.src;
    const rn = k + 1;
    const src = row.src != null ? original.get(row.src) : null;
    const origVals = row.src != null ? orig[row.src - 1] || [] : [];
    const width = Math.max(row.v.length, src ? Math.max(0, ...[...src.cells.keys()].map(c => c + 1)) : 0);
    let cells = '';
    for (let c = 0; c < width; c++) {
      const ref = `${colName(c)}${rn}`;
      const value = row.v[c] ?? '';
      const oc = src && src.cells.get(c);
      if (oc && value === (origVals[c] ?? '') && (rn === row.src || !oc.formula)) {
        cells += oc.xml.replace(/(<c\b[^>]*?\s)r="[A-Z]+\d+"/, `$1r="${ref}"`);
      } else {
        if (oc && oc.formula && value === (origVals[c] ?? '')) warnings.push(`${sheetName}!${ref} 的公式随行移动后改为写值`);
        const kind = oc ? kindOf(oc.attrs) : kindAbove(c, row.src != null ? row.src - 1 : lastSrc);
        cells += cellXml(ref, value, oc ? styleOf(oc.attrs) : undefined, kind);
      }
      if (value !== '') maxCol = Math.max(maxCol, c + 1);
    }
    if (!cells && !(src && /\s(s|ht|customHeight|hidden)="/.test(src.attrs))) return;
    const attrs = src ? stripAttr(stripAttr(src.attrs, 'r'), 'spans') : '';
    out.push(`<row r="${rn}"${attrs}>${cells}</row>`);
    lastRow = rn;
  });
  let next = xml.slice(0, sd.index) + `<sheetData>${out.join('')}</sheetData>` + xml.slice(sd.index + sd[0].length);
  const dim = lastRow && maxCol ? `A1:${colName(maxCol - 1)}${lastRow}` : 'A1';
  next = next.replace(/<dimension\b[^>]*\/>/, `<dimension ref="${dim}"/>`);
  if (moved && /<(conditionalFormatting|dataValidation|hyperlink|autoFilter)\b/.test(xml)) {
    warnings.push(`工作表「${sheetName}」的条件格式 / 数据验证 / 超链接 / 筛选区域没有随插入 / 删除的行移动`);
  }
  return { xml: next, warnings };
}

/**
 * 在 buf（xlsx）上应用编辑后的工作表：sheets = [{ name, rows: [{ src, v }] }]。
 * 只能改两边都有的工作表；返回 { buffer, warnings }
 */
function patchWorkbook(buf, sheets) {
  const entries = readEntries(buf);
  const byName = new Map(entries.map(e => [e.name.replace(/^\//, ''), e]));
  const values = new Map(readWorkbook(buf).map(s => [s.name, s.rows]));
  const warnings = [];
  for (const sheet of sheets) {
    const file = sheetFileOf(byName, sheet.name);
    const entry = file && byName.get(file);
    if (!entry) throw new Error(`找不到工作表「${sheet.name}」`);
    const r = rewriteSheet(entryText(entry), sheet.rows, values.get(sheet.name) || [], sheet.name);
    setText(entry, r.xml);
    warnings.push(...r.warnings);
  }
  // 计算链引用旧单元格位置：删掉，由 Excel 打开时重建
  const calc = entries.findIndex(e => e.name === 'xl/calcChain.xml');
  if (calc >= 0) {
    entries.splice(calc, 1);
    const ct = byName.get('[Content_Types].xml');
    if (ct) setText(ct, entryText(ct).replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/, ''));
    const rels = byName.get('xl/_rels/workbook.xml.rels');
    if (rels) setText(rels, entryText(rels).replace(/<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/, ''));
  }
  return { buffer: writeZip(entries), warnings };
}

module.exports = { patchWorkbook, crc32 };
