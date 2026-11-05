'use strict';
// 极简 xlsx 读取器：只取每个工作表的单元格「值」（公式取缓存结果），用于本地与云端的差异比较。
// 不依赖第三方库：xlsx 是 zip 包，用 zlib 解压后按 OOXML 结构解析 workbook / sharedStrings / worksheets。
const fs = require('node:fs');
const zlib = require('node:zlib');

// ---------- zip ----------
function readZip(buf) {
  // End of Central Directory：从文件尾往前找签名（尾部最多带 64KB 注释）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 zip 目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('xlsx 的 zip 目录已损坏');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name.replace(/^\//, ''), { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: name => entries.has(name),
    names: () => [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const lh = e.localOffset;
      if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error(`xlsx 内文件头损坏：${name}`);
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const data = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return data.toString('utf8');
      if (e.method === 8) return zlib.inflateRawSync(data).toString('utf8');
      throw new Error(`不支持的压缩方式 ${e.method}：${name}`);
    }
  };
}

// ---------- xml 小工具 ----------
function decodeXml(s) {
  return s
    .replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => {
      if (e === 'lt') return '<';
      if (e === 'gt') return '>';
      if (e === 'amp') return '&';
      if (e === 'quot') return '"';
      if (e === 'apos') return "'";
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    })
    // OOXML 对控制字符的转义：_x000D_ 等
    .replace(/_x([0-9a-fA-F]{4})_/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

function attrs(s) {
  const out = {};
  const re = /([\w:]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = decodeXml(m[3] != null ? m[3] : m[4]);
  return out;
}

// 拼接一段 xml 里所有 <t> 文本（跳过拼音注音 <rPh>）
function textOf(xml) {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(clean))) out += m[1] ? decodeXml(m[1]) : '';
  return out;
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function colName(index) {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// 数字统一成规范写法：Excel 与 Google 导出的浮点尾数可能不同（0.1 / 0.10000000000000001）
function normalizeNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return String(parseFloat(n.toPrecision(15)));
}

// ---------- workbook ----------
function resolveTarget(target) {
  const t = String(target || '').replace(/\\/g, '/');
  if (t.startsWith('/')) return t.slice(1);
  const parts = ['xl'];
  for (const seg of t.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function parseSheet(xml, sharedStrings) {
  const rows = []; // rows[r][c] = string
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;
  let nextRow = 0;
  while ((rm = rowRe.exec(xml))) {
    const ra = attrs(rm[1]);
    const r = ra.r ? parseInt(ra.r, 10) - 1 : nextRow;
    nextRow = r + 1;
    if (!rm[2]) continue;
    let nextCol = 0;
    let cm;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(rm[2]))) {
      const a = attrs(cm[1]);
      let c = nextCol;
      if (a.r) {
        const mm = /^([A-Z]+)/.exec(a.r);
        if (mm) c = colIndex(mm[1]);
      }
      nextCol = c + 1;
      const inner = cm[2] || '';
      const vm = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
      const raw = vm ? decodeXml(vm[1]) : '';
      let value;
      switch (a.t) {
        case 's': value = sharedStrings[parseInt(raw, 10)] ?? ''; break;
        case 'inlineStr': value = textOf(inner.replace(/<f\b[\s\S]*?<\/f>/g, '')); break;
        case 'b': value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw; break;
        case 'str': case 'e': case 'd': value = raw; break;
        default: value = raw === '' ? '' : normalizeNumber(raw);
      }
      if (value === '') continue;
      (rows[r] || (rows[r] = []))[c] = value;
    }
  }
  // 补齐空洞，去掉尾部空行
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const dense = Array.from({ length: row.length }, (_, j) => row[j] ?? '');
    while (dense.length && dense[dense.length - 1] === '') dense.pop();
    out.push(dense);
  }
  while (out.length && out[out.length - 1].length === 0) out.pop();
  return out;
}

/** 读取 xlsx：返回 [{ name, rows: string[][] }]，按工作簿里的工作表顺序 */
function readWorkbook(input) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const zip = readZip(buf);
  const wb = zip.read('xl/workbook.xml');
  if (!wb) throw new Error('不是有效的 xlsx（缺少 xl/workbook.xml）');
  const relsXml = zip.read('xl/_rels/workbook.xml.rels') || '';
  const rels = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    rels.set(a.Id, a.Target);
  }
  const ssXml = zip.read('xl/sharedStrings.xml');
  const shared = [];
  if (ssXml) for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(m[1] ? textOf(m[1]) : '');

  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    const rid = a['r:id'] || Object.entries(a).find(([k]) => /:id$/.test(k))?.[1];
    const target = rels.get(rid);
    const file = target ? resolveTarget(target) : null;
    const xml = file ? zip.read(file) : null;
    sheets.push({ name: a.name, rows: xml ? parseSheet(xml, shared) : [] });
  }
  return sheets;
}

module.exports = { readWorkbook, readZip, colName, colIndex, normalizeNumber, decodeXml };
