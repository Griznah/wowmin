const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '../renderer/scripts/utils/dashboard-data.ts'), 'utf8');
const compiled = esbuild.transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const moduleContext = { exports: {} };
vm.runInNewContext(compiled, { module: moduleContext, exports: moduleContext.exports });
const { getEnglishMotd, getServerUptime } = moduleContext.exports;

test('uptime comes from server info rather than an unsupported command', () => {
  const info = 'AzerothCore rev. abc\r\nConnected players: 0. Characters in world: 1234.\r\nServer uptime: 48 minute(s) 41 second(s)\r\n';
  assert.equal(getServerUptime(info), '48 minute(s) 41 second(s)');
  assert.equal(getServerUptime('Unavailable'), null);
});

test('only enUS MOTD is shown', () => {
  const message = 'Current Message of the day:\r\nenUS: Welcome to Jelly!\r\nkoKR: Another greeting\r\nfrFR: Bonjour';
  assert.equal(getEnglishMotd(message), 'Welcome to Jelly!');
  assert.equal(getEnglishMotd('koKR: Hello'), null);
  assert.equal(getEnglishMotd('enUS: First line\nSecond line\nfrFR: Different'), 'First line\nSecond line');
});
