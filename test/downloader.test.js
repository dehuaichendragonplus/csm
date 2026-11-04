const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { downloadOne } = require('../lib/downloader');

function startMockServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/exportTable` });
    });
  });
}

test('downloadOne writes file and returns byte count', async () => {
  const payload = Buffer.from('hello-xlsx-content');
  const { server, baseUrl } = await startMockServer((req, res) => {
    assert.match(req.url, /spreadsheetId=abc/);
    assert.match(req.url, /password=dragonplus/);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(payload);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downloader-test-'));
  const savePath = path.join(dir, 'sub/file.xlsx');
  try {
    const bytes = await downloadOne({ baseUrl, spreadsheetId: 'abc', password: 'dragonplus', savePath, mergeCells: false });
    assert.strictEqual(bytes, payload.length);
    assert.deepStrictEqual(fs.readFileSync(savePath), payload);
  } finally {
    server.close();
  }
});

test('downloadOne rejects on non-200 status', async () => {
  const { server, baseUrl } = await startMockServer((_req, res) => {
    res.writeHead(403);
    res.end('forbidden');
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downloader-test-'));
  const savePath = path.join(dir, 'file.xlsx');
  try {
    await assert.rejects(
      downloadOne({ baseUrl, spreadsheetId: 'abc', password: 'dragonplus', savePath, mergeCells: false }),
      /403/
    );
    assert.strictEqual(fs.existsSync(savePath), false, 'no file should be created on failure');
  } finally {
    server.close();
  }
});

test('downloadOne passes mergeCells as includeFormulas query param', async () => {
  let received;
  const { server, baseUrl } = await startMockServer((req, res) => {
    received = req.url;
    res.writeHead(200);
    res.end('x');
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downloader-test-'));
  try {
    await downloadOne({ baseUrl, spreadsheetId: 'abc', password: 'p', savePath: path.join(dir, 'a.xlsx'), mergeCells: true });
    assert.match(received, /includeFormulas=true/);
  } finally {
    server.close();
  }
});
