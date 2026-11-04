'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');

function runCommand({ command, args, cwd, onLog }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    child.stdout.on('data', d => onLog(d.toString()));
    child.stderr.on('data', d => onLog(d.toString()));
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve(code);
      else reject(new Error(`exit ${code}`));
    });
  });
}

function resolveScriptCommand(scriptBase, platform) {
  if (platform === 'win32') {
    return { command: 'cmd.exe', args: ['/c', `${scriptBase}.bat`] };
  }
  return { command: 'bash', args: [`${scriptBase}.sh`] };
}

function runGenClient({ toolsDir, onLog }) {
  const { command, args } = resolveScriptCommand('gen_client', process.platform);
  return runCommand({ command, args, cwd: toolsDir, onLog });
}

function runGenLocalization({ toolsDir, onLog }) {
  const { command, args } = resolveScriptCommand('gen_localization', process.platform);
  return runCommand({ command, args, cwd: toolsDir, onLog });
}

// 「执行代码生成」与同步后的生成统一走这里:先导出多语言(生成 Localization.xml
// 定义),再生成客户端代码与数据。多语言这步失败会抛出,不会继续跑 gen_client。
async function runLocalizationThenClient({ toolsDir, onLog }) {
  onLog('\n===== running gen_localization =====\n');
  await runGenLocalization({ toolsDir, onLog });
  onLog('\n===== running gen_client =====\n');
  return runGenClient({ toolsDir, onLog });
}

// 按配置顺序执行一组步骤（任一步失败即抛出，不继续后续步骤）。
// step: { label, cwd, command: { unix, win } }，命令经系统 shell 执行，支持管道/参数。
async function runSteps({ steps, platform = process.platform, onLog }) {
  let code = 0;
  for (const step of steps) {
    onLog(`\n===== ${step.label} =====\n`);
    const win = platform === 'win32';
    code = await runCommand({
      command: win ? 'cmd.exe' : 'bash',
      args: win ? ['/c', step.command.win] : ['-c', step.command.unix],
      cwd: step.cwd,
      onLog
    });
  }
  return code;
}

module.exports = { runSteps, runCommand, resolveScriptCommand, runGenClient, runGenLocalization, runLocalizationThenClient };
