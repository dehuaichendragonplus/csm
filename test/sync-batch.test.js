const { test } = require('node:test');
const assert = require('node:assert/strict');
let Batch;
try { Batch = require('../public/sync-batch'); } catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

test('重试只取失败项并合并原批次结果', () => {
  assert.ok(Batch, '缺少批次结果模型');
  const batch = Batch.create('Game', [{ path: 'A', name: '商品' }, { path: 'B', name: '活动' }]);
  Batch.apply(batch, ['A', 'B'], [{ path: 'A', success: true }, { path: 'B', success: false, error: '超时' }]);
  assert.deepEqual(Batch.failedPaths(batch), ['B']);
  assert.equal(Batch.complete(batch), false);
  Batch.apply(batch, ['B'], [{ path: 'B', success: true }]);
  assert.deepEqual(Batch.failedPaths(batch), []);
  assert.equal(Batch.complete(batch), true);
  assert.equal(batch.items.get('A').status, 'success');
});

test('连接提前结束时保留明确结果并标记待重试项，摘要列出变化与动作状态', () => {
  assert.ok(Batch, '缺少批次结果模型');
  const batch = Batch.create('Game', [{ path: 'A', name: '商品' }, { path: 'B' }]);
  Batch.apply(batch, ['A', 'B'], [{ path: 'A', success: true, summary: {
    added: 0, changed: 1, removed: 0, samples: [{ sheet: 'Items', record: '10023', field: 'price', local: '6', cloud: '12' }]
  } }], '连接中断');
  assert.deepEqual(Batch.failedPaths(batch), ['B']);
  assert.match(Batch.format(batch), /10023.*price.*6 → 12/);
  assert.match(Batch.format(batch), /B.*连接中断/);
  assert.match(Batch.format(batch), /导出.*等待/);
});
