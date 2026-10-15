const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const output = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/managed-connection-lifecycle.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
}).outputFiles[0].text;
const context = { module: { exports: {} }, setTimeout, clearTimeout };
context.exports = context.module.exports;
vm.runInNewContext(output, context);
const { ManagedConnectionLifecycle } = context.module.exports;
const serviceNames = ['soap', 'worldDatabase', 'mapDatabase', 'economyDatabase'];

function connector(options = {}) {
  let connected = false;
  let attempts = 0;
  let disconnects = 0;
  return {
    api: {
      connected: () => connected,
      check: options.check ? () => options.check() : undefined,
      connect: async () => {
        attempts += 1;
        const success = options.connect ? await options.connect(attempts) : true;
        connected = success;
        return { success, message: success ? 'connected' : 'offline' };
      },
      disconnect: async () => {
        disconnects += 1;
        connected = false;
      },
    },
    counts: () => ({ attempts, disconnects }),
  };
}

function lifecycleWith(overrides = {}) {
  const fixtures = Object.fromEntries(serviceNames.map((name) => [name, overrides[name] || connector()]));
  const lifecycle = new ManagedConnectionLifecycle(
    Object.fromEntries(serviceNames.map((name) => [name, fixtures[name].api])),
    { initialRetryMs: 60000, maximumRetryMs: 60000 },
  );
  return { lifecycle, fixtures };
}

test('connects each managed service once and reports authoritative status', async () => {
  const { lifecycle, fixtures } = lifecycleWith();
  const status = await lifecycle.start();
  assert.equal(status.managed, true);
  for (const name of serviceNames) {
    assert.equal(status.services[name].phase, 'connected');
    assert.equal(fixtures[name].counts().attempts, 1);
  }
  await lifecycle.stop();
  for (const name of serviceNames) assert.equal(fixtures[name].counts().disconnects, 1);
});

test('serializes concurrent managed connection attempts', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowSoap = connector({ connect: async () => { await gate; return true; } });
  const { lifecycle, fixtures } = lifecycleWith({ soap: slowSoap });
  const first = lifecycle.start();
  const second = lifecycle.ensureConnected();
  release();
  await Promise.all([first, second]);
  assert.equal(fixtures.soap.counts().attempts, 1);
  await lifecycle.stop();
});

test('detects a lost managed connection and recovers it', async () => {
  let available = true;
  const soap = connector({
    check: async () => available,
    connect: async () => available,
  });
  const { lifecycle } = lifecycleWith({ soap });
  assert.equal((await lifecycle.start()).services.soap.phase, 'connected');

  available = false;
  assert.equal((await lifecycle.ensureConnected()).services.soap.phase, 'degraded');
  available = true;
  assert.equal((await lifecycle.ensureConnected()).services.soap.phase, 'connected');
  await lifecycle.stop();
});

test('keeps startup non-fatal and recovers a degraded service', async () => {
  let available = false;
  const map = connector({ connect: async () => available });
  const { lifecycle } = lifecycleWith({ mapDatabase: map });
  const degraded = await lifecycle.start();
  assert.equal(degraded.services.mapDatabase.phase, 'degraded');
  assert.equal(degraded.services.mapDatabase.error, 'offline');
  assert.ok(degraded.services.mapDatabase.retryAt > Date.now());

  available = true;
  const recovered = await lifecycle.ensureConnected();
  assert.equal(recovered.services.mapDatabase.phase, 'connected');
  assert.equal(recovered.services.mapDatabase.error, null);
  await lifecycle.stop();
});
