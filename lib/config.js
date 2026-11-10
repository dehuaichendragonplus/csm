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
      hidden: !!a.hidden,
      steps: a.steps.map((s, i) => ({
        label: s.label || `step ${i + 1}`,
        cwd: path.resolve(baseDir, s.cwd || '.'),
        command: normalizeCommand(s.command, `action ${a.id} step ${i + 1}`)
      }))
    });
  }
  return out;
}

function detectLubanAction(baseDir) {
  const cwd = path.join(baseDir, 'Tools');
  const extension = process.platform === 'win32' ? 'bat' : 'sh';
  const hasScript = name => {
    try { return fs.statSync(path.join(cwd, `${name}.${extension}`)).isFile(); }
    catch (_) { return false; }
  };
  if (!hasScript('gen_client')) return null;
  const step = (name, label) => ({
    label,
    cwd,
    command: { unix: `bash ${name}.sh`, win: `${name}.bat` }
  });
  const steps = [step('gen_client', '生成客户端代码与数据')];
  if (hasScript('gen_localization')) steps.unshift(step('gen_localization', '生成多语言'));
  return { id: 'gen-client', label: 'Luban导出', hidden: false, steps };
}

function normalizeCloudRoot(v) {
  if (!v || typeof v !== 'object') return null;
  const folderId = String(v.folderId || '').trim();
  if (!folderId) return null;
  const local = String(v.local == null ? 'Datas' : v.local).trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return { folderId, local };
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
  if (!actions.some(action => action.id === 'gen-client')) {
    const luban = detectLubanAction(baseDir);
    if (luban) actions.push(luban);
  }
  return {
    configPath: path.resolve(configPath),
    baseDir,
    title: raw.title || 'CSM',
    filelistPath: path.resolve(baseDir, raw.filelist),
    sidecarPath: raw.sidecar ? path.resolve(baseDir, raw.sidecar) : null,
    statePath: overrides.statePath || path.join(baseDir, '.sync_state.json'),
    allowUpload: raw.allowUpload !== false,
    // 云端目录 ↔ 本地目录映射（可选）：{ folderId, local }。不配置时按已有条目自动推断
    cloudRoot: normalizeCloudRoot(raw.cloudRoot),
    port: Number.isInteger(raw.port) ? raw.port : 7321,
    actions
  };
}

// 前端可见的配置子集（不含本地绝对路径）
function publicConfig(cfg) {
  return {
    title: cfg.title,
    allowUpload: cfg.allowUpload,
    cloudRoot: cfg.cloudRoot,
    actions: cfg.actions.map(a => ({ id: a.id, label: a.label, hidden: !!a.hidden }))
  };
}

module.exports = { CONFIG_FILENAME, loadConfig, publicConfig };
