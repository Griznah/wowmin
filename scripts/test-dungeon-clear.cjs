const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '../src/dungeon-clear-config.ts'), 'utf8');
const compiled = esbuild.transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const moduleContext = { exports: {} };
vm.runInNewContext(compiled, { module: moduleContext, exports: moduleContext.exports, URL });
const { buildContentSecurityPolicy, deriveDungeonClearUrl, normalizeDungeonClearUrl } = moduleContext.exports;

test('configured Dungeon Clear URLs are normalized and restricted to HTTP(S)', () => {
  assert.equal(normalizeDungeonClearUrl(undefined), null);
  assert.equal(normalizeDungeonClearUrl(' https://deck.example.test/ui '), 'https://deck.example.test/ui/');
  assert.throws(() => normalizeDungeonClearUrl('file:///tmp/deck'), /http:\/\/ or https:\/\//);
  assert.throws(() => normalizeDungeonClearUrl('http://admin:secret@deck.test/'), /must not contain credentials/);
});

test('default Dungeon Clear URL uses the current host on port 8790', () => {
  assert.equal(deriveDungeonClearUrl('http', 'realm.lan:3000'), 'http://realm.lan:8790/');
  assert.equal(deriveDungeonClearUrl('https', 'realm.lan'), 'https://realm.lan:8790/');
  assert.equal(deriveDungeonClearUrl('http', '[::1]:3000'), 'http://[::1]:8790/');
  assert.equal(deriveDungeonClearUrl('http', 'bad host header'), 'http://localhost:8790/');
});

test('CSP permits only the configured frame origin', () => {
  const policy = buildContentSecurityPolicy('https://deck.example.test:8790/path/');
  assert.match(policy, /frame-src https:\/\/deck\.example\.test:8790/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.doesNotMatch(policy, /frame-src \*/);
});
