const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { findAvailablePort } = require('../lib/port-scanner');

test('findAvailablePort returns an integer >= start', async () => {
  const port = await findAvailablePort(7321);
  assert.ok(Number.isInteger(port));
  assert.ok(port >= 7321);
});

test('findAvailablePort skips occupied ports', async () => {
  const occupied = await new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const occupiedPort = occupied.address().port;
  try {
    const port = await findAvailablePort(occupiedPort);
    assert.notStrictEqual(port, occupiedPort);
    assert.ok(port > occupiedPort);
  } finally {
    occupied.close();
  }
});
