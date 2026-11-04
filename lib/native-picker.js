'use strict';
const fs = require('node:fs');
const { execFile } = require('node:child_process');

// 调系统原生「选择文件夹」对话框（服务只监听 127.0.0.1，弹窗出现在本机）。
// 成功返回 { path }；用户取消返回 { cancelled: true }；平台不支持抛错（前端回退到页内浏览）。
const MAC_SCRIPT = `on run argv
  set startDir to item 1 of argv
  tell application "System Events"
    activate
    if startDir is not "" then
      set f to choose folder with prompt "选择项目的配置表目录" default location (POSIX file startDir)
    else
      set f to choose folder with prompt "选择项目的配置表目录"
    end if
  end tell
  return POSIX path of f
end run`;

const WIN_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$d.Description = "选择项目的配置表目录"',
  'if ($args.Count -gt 0 -and $args[0]) { $d.SelectedPath = $args[0] }',
  'if ($d.ShowDialog() -eq "OK") { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.SelectedPath }'
].join('; ');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
  });
}

function existingDir(p) {
  try { return p && fs.statSync(p).isDirectory() ? p : ''; } catch (_) { return ''; }
}

async function pickFolder(startDir, platform = process.platform) {
  const start = existingDir(startDir);
  try {
    if (platform === 'darwin') {
      const out = (await run('osascript', ['-e', MAC_SCRIPT, start])).trim();
      return out ? { path: out.replace(/\/+$/, '') || '/' } : { cancelled: true };
    }
    if (platform === 'win32') {
      const out = (await run('powershell', ['-NoProfile', '-STA', '-Command', `& { ${WIN_SCRIPT} }`, start])).trim();
      return out ? { path: out } : { cancelled: true };
    }
  } catch (err) {
    // osascript 用户取消：错误码 -128
    if (/-128|User canceled/i.test(`${err.stderr || ''}${err.message || ''}`)) return { cancelled: true };
    throw err;
  }
  throw new Error('当前系统不支持原生目录选择');
}

module.exports = { pickFolder };
