'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILENAME = 'syncmanager.config.json';

function normalizeCommand(cmd, where) {
  if (typeof cmd === 'string') return { unix: cmd, win: cmd };
  if (cmd && (cmd.unix || cmd.win)) return { unix: cmd.unix || cmd.win, win: cmd.win || cmd.unix };
  throw new Error(`${where}: command 必须是字符串或 { unix, win }`);
}

function normalizeActions(actions, baseDir) {
  const out = [];
  const seen = new Set();
  for (const a of actions || []) {
    if (!a || !a.id || !a.label) throw new Error('actions 每项需要 id 和 label');
    if (seen.has(a.id)) throw new Error(`actions 中 id 重复: ${a.id}`);
    seen.add(a.id);
    if (!Array.isArray(a.steps) || a.steps.length === 0) throw new Error(`action ${a.id} 需要非空 steps`);
    out.push({
      id: a.id,
      label: a.label,
      steps: a.steps.map((s, i) => ({
        label: s.label || `step ${i + 1}`,
        cwd: path.resolve(baseDir, s.cwd || '.'),
        command: normalizeCommand(s.command, `action ${a.id} step ${i + 1}`)
      }))
    });
  }
  return out;
}

/**
 * 读取并校验配置。配置文件里的相对路径一律相对「配置文件所在目录」解析。
 * overrides.statePath：平台模式下把同步状态存到平台数据目录，而不是项目目录。
 */
function loadConfig(configPath, overrides = {}) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`找不到配置文件 ${configPath}`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`配置文件不是合法 JSON: ${err.message}`);
  }
  if (!raw.filelist) throw new Error('配置缺少必填项 filelist（表格清单 JSON 的路径）');

  const baseDir = path.dirname(path.resolve(configPath));
  const actions = normalizeActions(raw.actions, baseDir);
  const exp = raw.export || {};
  return {
    configPath: path.resolve(configPath),
    baseDir,
    title: raw.title || 'CSM',
    filelistPath: path.resolve(baseDir, raw.filelist),
    sidecarPath: raw.sidecar ? path.resolve(baseDir, raw.sidecar) : null,
    statePath: overrides.statePath || path.join(baseDir, '.sync_state.json'),
    // export.url 为空时直接走 Drive API 导出 xlsx（仅需 Google 授权，不依赖内部导出服务）
    exportUrl: exp.url || null,
    exportPassword: exp.password || '',
    allowUpload: raw.allowUpload !== false,
    port: Number.isInteger(raw.port) ? raw.port : 7321,
    actions
  };
}

// 前端可见的配置子集（不含密码、绝对路径）
function publicConfig(cfg) {
  return {
    title: cfg.title,
    allowUpload: cfg.allowUpload,
    actions: cfg.actions.map(a => ({ id: a.id, label: a.label }))
  };
}

module.exports = { CONFIG_FILENAME, loadConfig, publicConfig };
