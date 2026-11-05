const { test } = require('node:test');
const assert = require('node:assert');
const { getModifiedTimes, buildBatchBody, parseBatchResponse } = require('../lib/drive-api');

// 按 Drive batch API 的格式拼一个响应：items = [{ status, body }]
function fakeBatchResponse(items, boundary = 'batch_abc') {
  const text = items.map((it, i) => [
    `--${boundary}`,
    'Content-Type: application/http',
    `Content-ID: <response-item${i}>`,
    '',
    `HTTP/1.1 ${it.status} ${it.status === 200 ? 'OK' : 'ERR'}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(it.body),
    ''
  ].join('\r\n')).join('') + `--${boundary}--`;
  return { data: text, headers: { 'content-type': `multipart/mixed; boundary=${boundary}` } };
}

test('buildBatchBody：每个文件一段 GET，带 supportsAllDrives 和字段', () => {
  const body = buildBatchBody(['id1', 'id2'], 'B');
  assert.match(body, /--B\r\nContent-Type: application\/http\r\nContent-ID: <item0>\r\n\r\nGET \/drive\/v3\/files\/id1\?fields=[^ ]+&supportsAllDrives=true HTTP\/1\.1/);
  assert.match(body, /Content-ID: <item1>/);
  assert.ok(body.endsWith('--B--'));
});

test('parseBatchResponse：按 Content-ID 取回每一项的状态码和 JSON', () => {
  const r = fakeBatchResponse([{ status: 200, body: { id: 'a', modifiedTime: 't1' } }, { status: 404, body: { error: { message: 'nf' } } }]);
  const parts = parseBatchResponse(r.data, r.headers['content-type']);
  assert.deepStrictEqual(parts.get(0), { status: 200, body: { id: 'a', modifiedTime: 't1' } });
  assert.strictEqual(parts.get(1).status, 404);
});

test('getModifiedTimes：一次批量请求查完；404 记为错误，不再逐个重查', async () => {
  const calls = [];
  const request = async opts => {
    calls.push(opts);
    return fakeBatchResponse([
      { status: 200, body: { id: 'a', name: 'A', modifiedTime: '2026-01-01T00:00:00Z', lastModifyingUser: { displayName: '张三' } } },
      { status: 404, body: { error: { code: 404, message: 'File not found' } } }
    ]);
  };
  const m = await getModifiedTimes(['a', 'b', 'a'], null, { request });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].timeout > 0, true);
  assert.deepStrictEqual(m.get('a'), { modifiedTime: '2026-01-01T00:00:00Z', name: 'A', modifiedBy: '张三', error: null });
  assert.strictEqual(m.get('b').error, 'not_found');
});

test('getModifiedTimes：超过 100 个分块请求；被限流的条目和失败的分块改为逐个查询', async () => {
  const ids = Array.from({ length: 150 }, (_, i) => `id${i}`);
  let n = 0;
  const request = async opts => {
    n++;
    if (opts.data.includes('/files/id100?')) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); // 第二块整块失败
    const count = (opts.data.match(/Content-ID/g) || []).length;
    return fakeBatchResponse(Array.from({ length: count }, (_, i) => (i === 3
      ? { status: 429, body: { error: { code: 429, message: 'rate' } } }
      : { status: 200, body: { modifiedTime: `t${i}` } })));
  };
  // 兜底的逐个查询走 googleapis：给一个必然失败的假授权对象，确认这些条目确实被送去重查（结果记为错误，而不是丢失）
  const m = await getModifiedTimes(ids, {
    request: () => Promise.reject(Object.assign(new Error('offline'), { code: 400 }))
  }, { request, retryOpts: { retries: 0 } });
  assert.strictEqual(n, 3, '第一块 1 次；第二块失败后重试 1 次');
  assert.strictEqual(m.size, 150);
  assert.strictEqual(m.get('id0').modifiedTime, 't0');
  assert.ok(m.get('id3').error, '被限流的条目重查（这里重查也失败）后记为错误');
  assert.ok(m.get('id120').error, '整块失败的条目重查后记为错误');
});
