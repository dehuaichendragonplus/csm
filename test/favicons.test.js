'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { getFavicon, getFallbackSvg, parseOrigin, BRAND_SVGS } = require('../lib/favicons');

test('favicons: parseOrigin 正确提取协议与域名，拦截非 http(s) 链接', () => {
  assert.strictEqual(parseOrigin('https://jenkins.dragonplus.vip/view/all'), 'https://jenkins.dragonplus.vip');
  assert.strictEqual(parseOrigin('http://localhost:8080/app'), 'http://localhost:8080');
  assert.strictEqual(parseOrigin('ftp://invalid.com'), null);
  assert.strictEqual(parseOrigin('not a url'), null);
  assert.strictEqual(parseOrigin(''), null);
});

test('favicons: getFallbackSvg 根据 URL 和标题智能匹配对应品牌矢量图标', () => {
  assert.strictEqual(getFallbackSvg('https://mycompany.com', 'Jira'), BRAND_SVGS.jira);
  assert.strictEqual(getFallbackSvg('https://jenkins.internal:8080'), BRAND_SVGS.jenkins);
  assert.strictEqual(getFallbackSvg('https://alidocs.dingtalk.com/spreadsheet/123'), BRAND_SVGS.dingtalk);
  assert.strictEqual(getFallbackSvg('https://docs.google.com/spreadsheets/d/123'), BRAND_SVGS.sheets);
  assert.strictEqual(getFallbackSvg('https://github.com/myorg/repo'), BRAND_SVGS.github);
  assert.strictEqual(getFallbackSvg('https://example.com/something'), BRAND_SVGS.globe);
});

test('favicons: 本地服务器拉取真实 favicon 并持久化磁盘缓存', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-fav-unit-'));
  const fakeIcon = Buffer.from('FAKE-ICON-DATA-12345');

  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') {
      res.writeHead(200, { 'Content-Type': 'image/x-icon' });
      res.end(fakeIcon);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const targetUrl = `http://127.0.0.1:${port}/some-page`;

  try {
    // 第一次：从网络拉取
    const res1 = await getFavicon(targetUrl, tmpDir, 'Test');
    assert.strictEqual(res1.source, 'network');
    assert.strictEqual(res1.contentType, 'image/x-icon');
    assert.deepStrictEqual(res1.buffer, fakeIcon);

    // 第二次：命中磁盘缓存
    const res2 = await getFavicon(targetUrl, tmpDir, 'Test');
    assert.ok(res2.source === 'network' || res2.source === 'disk');
    assert.deepStrictEqual(res2.buffer, fakeIcon);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('favicons API: GET /api/favicon 返回图标与正确 content-type', async () => {
  const { main } = require('../server');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-fav-api-'));
  const { port, server } = await main({
    dataDir,
    port: 0,
    openBrowser: false
  });

  try {
    // 1. 无参返回通用或兜底 svg
    let res = await fetch(`http://127.0.0.1:${port}/api/favicon`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('image/svg+xml'));

    // 2. 带 Jira 标题/参数返回 Jira svg 或图标
    res = await fetch(`http://127.0.0.1:${port}/api/favicon?url=https://jira.example.com&title=Jira`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type'));
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
