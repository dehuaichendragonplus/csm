'use strict';
const { execFileSync } = require('node:child_process');

// 从访达 / Dock 启动的 App 拿不到终端里的 PATH（Homebrew、dotnet、nvm 等），
// 自定义动作里的命令会因此「找不到」。这里起一个登录 + 交互 shell 读出完整环境变量补回来。
const MARK = '__CSM_ENV__';

function parseEnvOutput(out) {
  const start = out.indexOf(MARK);
  const end = out.lastIndexOf(MARK);
  if (start < 0 || end <= start) return {};
  const body = out.slice(start + MARK.length, end);
  const env = {};
  for (const item of body.split('\0')) {
    const i = item.indexOf('=');
    if (i <= 0) continue;
    env[item.slice(0, i).replace(/^\s+/, '')] = item.slice(i + 1);
  }
  return env;
}

// 不覆盖 Electron / App 自身依赖的变量，只补充缺失项并以 shell 的 PATH 为准
const SKIP = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL', 'TERM_SESSION_ID']);

function mergeEnv(target, shellEnv) {
  for (const [k, v] of Object.entries(shellEnv)) {
    if (SKIP.has(k) || k.startsWith('ELECTRON_')) continue;
    if (k === 'PATH' || target[k] === undefined) target[k] = v;
  }
  return target;
}

function loadShellEnv({ platform = process.platform, shell = process.env.SHELL || '/bin/zsh', timeout = 8000 } = {}) {
  if (platform === 'win32') return {};
  const out = execFileSync(shell, ['-ilc', `printf '${MARK}'; env -0; printf '${MARK}'`], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } // 避免 oh-my-zsh 启动时卡在更新提示
  });
  return parseEnvOutput(out);
}

function fixProcessEnv() {
  try {
    mergeEnv(process.env, loadShellEnv());
    return true;
  } catch (_err) {
    // 兜底：至少把常见安装位置加进 PATH
    const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/local/share/dotnet'];
    const parts = (process.env.PATH || '').split(':');
    process.env.PATH = [...extra.filter(p => !parts.includes(p)), ...parts].join(':');
    return false;
  }
}

module.exports = { parseEnvOutput, mergeEnv, loadShellEnv, fixProcessEnv };
