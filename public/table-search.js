// 配置表搜索：浏览器里挂到 window.TableSearch，Node 测试里 require。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TableSearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 关键词按空白拆分，大小写不敏感；多个关键词需同时命中（AND）
  function parseQuery(q) {
    return String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  // 参与搜索的字段：表名、xlsx 路径、云端表名、备注、spreadsheetId
  function haystack(row) {
    return [row.name, row.path, row.cloudName, row.description, row.spreadsheetId]
      .filter(Boolean).join('\n').toLowerCase();
  }

  function matchRow(row, terms) {
    if (!terms.length) return true;
    const h = haystack(row);
    return terms.every(t => h.includes(t));
  }

  function filterRows(rows, query) {
    const terms = parseQuery(query);
    return terms.length ? rows.filter(r => matchRow(r, terms)) : rows;
  }

  // 把文本切成 [{ text, hit }] 片段用于高亮（不拼 HTML，避免注入）
  function splitHighlight(text, terms) {
    const s = String(text == null ? '' : text);
    if (!terms.length || !s) return [{ text: s, hit: false }];
    const lower = s.toLowerCase();
    const marks = new Array(s.length).fill(false);
    for (const t of terms) {
      let i = lower.indexOf(t);
      while (i >= 0) {
        for (let k = i; k < i + t.length; k++) marks[k] = true;
        i = lower.indexOf(t, i + t.length);
      }
    }
    const parts = [];
    for (let i = 0; i < s.length; i++) {
      const last = parts[parts.length - 1];
      if (last && last.hit === marks[i]) last.text += s[i];
      else parts.push({ text: s[i], hit: marks[i] });
    }
    return parts;
  }

  return { parseQuery, matchRow, filterRows, splitHighlight };
});
