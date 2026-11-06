// 导出动作日志异常智能解析器
// 浏览器环境挂载到 window.ActionErrorParser，Node 测试环境 require。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ActionErrorParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 从错误日志文本中提取结构化报错信息
   * @param {string} logText - 运行日志文本
   * @param {Array} knownRows - 当前项目已知配置表列表 [{ name, path, spreadsheetId, ... }]
   * @returns {Object|null} 解析出的错误诊断对象
   */
  function parseActionError(logText, knownRows = []) {
    if (!logText || typeof logText !== 'string') return null;

    const lines = logText.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return null;

    // 筛选出疑似错误行（排除完成汇总行与发起行）
    const errorPattern = /error|failed|exception|fault|fail|crash|panic|fatal|未找到|找不到|类型不匹配|重复|越界|not\s*found|syntax|denied|refused|cannot|can't/i;
    const meaningfulLines = lines.filter(l => !l.startsWith('=== done:') && !l.startsWith('===') && !l.startsWith('→'));
    const errorLines = meaningfulLines.filter(l => errorPattern.test(l));

    // 如果没有任何含错误关键字的行，但调用方判定失败（例如 exitCode != 0），取倒数有效行
    const candidateLines = errorLines.length > 0 ? errorLines : meaningfulLines.slice(-5);

    let detectedTable = null;
    let detectedSheet = null;
    let detectedRecord = null;
    let detectedField = null;
    let detectedLineNum = null;
    let primaryMessage = '';
    let rawErrorLine = '';

    // 辅助函数：从已知 rows 中根据名称或路径匹配表格条目
    function findMatchingRow(targetNameOrPath) {
      if (!targetNameOrPath || !knownRows.length) return null;
      const clean = targetNameOrPath.trim().replace(/^['"`]+|['"`]+$/g, '').replace(/\\/g, '/');
      const baseNoExt = clean.split('/').pop().replace(/\.xlsx$/i, '');

      return knownRows.find(r => {
        if (!r) return false;
        if (r.path && r.path.toLowerCase() === clean.toLowerCase()) return true;
        if (r.name && r.name.toLowerCase() === clean.toLowerCase()) return true;
        if (r.name && r.name.toLowerCase() === baseNoExt.toLowerCase()) return true;
        const rBase = (r.path || '').split('/').pop().replace(/\.xlsx$/i, '');
        return rBase && rBase.toLowerCase() === baseNoExt.toLowerCase();
      }) || null;
    }

    // 从后往前扫（最近发生的错误通常在后面）
    for (let i = candidateLines.length - 1; i >= 0; i--) {
      const line = candidateLines[i];
      if (line.startsWith('=== done:') || line.startsWith('→')) continue;

      // 1. 匹配 Luban 典型格式：table: xxx, sheet: xxx, record: xxx, field: xxx
      const tableMatch = line.match(/(?:table|表名|表格)[:=\s]+([^\s,;]+)/i);
      const sheetMatch = line.match(/(?:sheet|工作表)[:=\s]+([^\s,;]+)/i);
      const recordMatch = line.match(/(?:record|记录|id|key)[:=\s]+([^\s,;]+)/i);
      const fieldMatch = line.match(/(?:field|字段|列)[:=\s]+([^\s,;]+)/i);
      const lineMatch = line.match(/(?:line|行号|第\s*(\d+)\s*行)[:=\s]*(\d+)?/i);
      const fileMatch = line.match(/([a-zA-Z0-9_\-\u4e00-\u9fa5/\\.]+\.xlsx)/i);

      if (!detectedTable && tableMatch) detectedTable = tableMatch[1].replace(/\.xlsx$/i, '');
      if (!detectedSheet && sheetMatch) detectedSheet = sheetMatch[1];
      if (!detectedRecord && recordMatch) detectedRecord = recordMatch[1];
      if (!detectedField && fieldMatch) detectedField = fieldMatch[1];
      if (!detectedLineNum && lineMatch) detectedLineNum = lineMatch[2] || lineMatch[1];
      if (!detectedTable && fileMatch) {
        detectedTable = fileMatch[1].split('/').pop().replace(/\.xlsx$/i, '');
      }

      if (!rawErrorLine && errorPattern.test(line)) {
        rawErrorLine = line;
      }
    }

    // 2. 如果没能正则提取到 table，尝试在错误行中反查已知表名
    let matchedRow = findMatchingRow(detectedTable);
    if (!matchedRow && knownRows.length) {
      for (const row of knownRows) {
        if (!row || !row.name) continue;
        const nameRegex = new RegExp(`\\b${escapeRegExp(row.name)}\\b|${escapeRegExp(row.path)}`, 'i');
        const hitLine = candidateLines.find(l => nameRegex.test(l));
        if (hitLine) {
          detectedTable = row.name;
          matchedRow = row;
          if (!rawErrorLine) rawErrorLine = hitLine;
          break;
        }
      }
    }

    if (!rawErrorLine && candidateLines.length) {
      rawErrorLine = candidateLines[candidateLines.length - 1];
    }

    primaryMessage = cleanErrorLine(rawErrorLine);

    // 组装人性化摘要
    const summaryParts = [];
    if (detectedTable) summaryParts.push(`配置表「${detectedTable}」`);
    if (detectedSheet) summaryParts.push(`工作表「${detectedSheet}」`);
    if (detectedLineNum) summaryParts.push(`第 ${detectedLineNum} 行`);
    if (detectedRecord) summaryParts.push(`记录 ID: ${detectedRecord}`);
    if (detectedField) summaryParts.push(`字段: ${detectedField}`);

    let summary = summaryParts.length ? `${summaryParts.join(' · ')} 检查未通过` : '脚本执行遇到错误';

    return {
      hasError: true,
      tableName: detectedTable || (matchedRow ? matchedRow.name : null),
      sheetName: detectedSheet,
      record: detectedRecord,
      field: detectedField,
      lineNum: detectedLineNum,
      matchedRow: matchedRow,
      filePath: matchedRow ? matchedRow.path : (detectedTable ? `${detectedTable}.xlsx` : null),
      summary,
      details: primaryMessage || rawErrorLine || '执行失败，详情请查看控制台日志',
      rawLine: rawErrorLine
    };
  }

  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function cleanErrorLine(line) {
    if (!line) return '';
    return line
      .replace(/^[\s!✓→✗⚡●=]+\s*/, '')
      .replace(/^\[(ERROR|FATAL|WARN)\]\s*/i, '')
      .replace(/^ERROR:\s*/i, '')
      .trim();
  }

  return { parseActionError, cleanErrorLine };
});
