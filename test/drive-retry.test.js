const { test } = require('node:test');
const assert = require('node:assert');
const { withRetry, isRetryable } = require('../lib/drive-api');

const err = (code, reason) => Object.assign(new Error(`e${code}`), { code, errors: reason ? [{ reason }] : undefined });

test('isRetryable：429 / 5xx / 403 限流 / 网络错误可重试，403 无权限与 404 不重试', () => {
  assert.ok(isRetryable(err(429)));
  assert.ok(isRetryable(err(503)));
  assert.ok(isRetryable(err('500')));
  assert.ok(isRetryable(err(403, 'userRateLimitExceeded')));
  assert.ok(isRetryable(err('ECONNRESET')));
  assert.ok(!isRetryable(err(403, 'insufficientPermissions')));
  assert.ok(!isRetryable(err(404)));
});

test('withRetry：限流后退避重试直到成功；不可重试的错误立即抛出', async () => {
  const waits = [];
  let n = 0;
  const v = await withRetry(async () => { if (++n < 3) throw err(429); return 'ok'; }, { sleep: async ms => { waits.push(ms); } });
  assert.strictEqual(v, 'ok');
  assert.strictEqual(waits.length, 2);
  assert.ok(waits[1] > waits[0] * 1.2, '指数退避');

  let m = 0;
  await assert.rejects(withRetry(async () => { m++; throw err(404); }, { sleep: async () => {} }), /e404/);
  assert.strictEqual(m, 1);

  let k = 0;
  await assert.rejects(withRetry(async () => { k++; throw err(500); }, { retries: 2, sleep: async () => {} }), /e500/);
  assert.strictEqual(k, 3);
});
