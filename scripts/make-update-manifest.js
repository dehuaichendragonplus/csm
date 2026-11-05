#!/usr/bin/env node
'use strict';
// 生成更新清单 dist/latest.json，和 dmg 一起上传到更新源（见 README「版本更新提示」）。
// 用法：node scripts/make-update-manifest.js --notes "本次更新内容" \
//         --arm64 <arm64 dmg 下载链接> --x64 <x64 dmg 下载链接> [--url <发布页>] [--out dist/latest.json]
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const pkg = require('../package.json');
const manifest = {
  version: pkg.version,
  date: new Date().toISOString(),
  notes: opt('notes') || '',
  url: opt('url') || undefined,
  downloads: {}
};
if (opt('arm64')) manifest.downloads['darwin-arm64'] = opt('arm64');
if (opt('x64')) manifest.downloads['darwin-x64'] = opt('x64');
if (!Object.keys(manifest.downloads).length && !manifest.url) {
  console.error('至少提供 --arm64 / --x64 下载链接或 --url 发布页');
  process.exit(1);
}
const out = path.resolve(opt('out') || path.join(__dirname, '..', 'dist', 'latest.json'));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`已生成 ${out}（版本 ${pkg.version}）`);
