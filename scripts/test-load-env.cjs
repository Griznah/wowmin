const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const esbuild = require('esbuild');

// The web service's settings files (src/load-env.ts): the system file wins
// over the project's .env, and the environment over both.

// The module loads the files when imported; here it runs against a stand-in
// process, so only the exported functions touch real files.
function loadModule() {
  const output = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'load-env.ts')], bundle: true, write: false, platform: 'node', format: 'cjs',
  }).outputFiles[0].text;
  const context = {
    module: { exports: {} }, require, __dirname: path.join(__dirname, '..', 'dist'), console,
    process: { platform: 'linux', env: {}, loadEnvFile: () => {} },
  };
  context.exports = context.module.exports;
  vm.runInNewContext(output, context);
  return context.module.exports;
}

const { settingsFiles, loadSettingsFiles } = loadModule();
const plain = (value) => JSON.parse(JSON.stringify(value));

test('loads the system settings file before the project .env', () => {
  assert.deepEqual(plain(settingsFiles('linux', {}, '/srv/wowmin')), ['/etc/wowmin.env', '/srv/wowmin/.env']);
  assert.deepEqual(plain(settingsFiles('win32', { ProgramData: 'C:\\ProgramData' }, '/srv/wowmin')),
    ['C:\\ProgramData\\wowmin\\wowmin.env', '/srv/wowmin/.env']);
  assert.deepEqual(plain(settingsFiles('win32', {}, '/srv/wowmin')), ['/srv/wowmin/.env'], 'no ProgramData, no system file');
});

test('the environment wins over the system file, and the system file over .env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowmin-env-'));
  const system = path.join(dir, 'wowmin.env');
  const project = path.join(dir, '.env');
  fs.writeFileSync(system, 'WOWMIN_TEST_SYSTEM=system\nWOWMIN_TEST_BOTH=system\nWOWMIN_TEST_SET=system\n');
  fs.writeFileSync(project, 'WOWMIN_TEST_BOTH=project\nWOWMIN_TEST_PROJECT=project\nWOWMIN_TEST_SET=project\n');
  process.env.WOWMIN_TEST_SET = 'environment';
  try {
    loadSettingsFiles([system, project], (file) => process.loadEnvFile(file), process.env);
    assert.equal(process.env.WOWMIN_TEST_SET, 'environment');
    assert.equal(process.env.WOWMIN_TEST_BOTH, 'system');
    assert.equal(process.env.WOWMIN_TEST_SYSTEM, 'system');
    assert.equal(process.env.WOWMIN_TEST_PROJECT, 'project');
  } finally {
    for (const name of ['SET', 'BOTH', 'SYSTEM', 'PROJECT']) delete process.env[`WOWMIN_TEST_${name}`];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skips missing files, and unreadable ones when the settings are already set', () => {
  const failing = (codes) => (file) => {
    const error = new Error(`${codes[file]}: ${file}`);
    error.code = codes[file];
    throw error;
  };
  const codes = { '/etc/wowmin.env': 'EACCES', '/srv/wowmin/.env': 'ENOENT' };
  const warnings = [];
  loadSettingsFiles(Object.keys(codes), failing(codes), { WOWMIN_USERNAME: 'admin' }, (message) => warnings.push(message));
  assert.deepEqual(warnings, [], 'systemd already set them from its EnvironmentFile');
  loadSettingsFiles(Object.keys(codes), failing(codes), {}, (message) => warnings.push(message));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not read \/etc\/wowmin\.env/);
  loadSettingsFiles(['/etc/wowmin.env'], failing({ '/etc/wowmin.env': 'EISDIR' }), { WOWMIN_USERNAME: 'admin' }, (message) => warnings.push(message));
  assert.equal(warnings.length, 2, 'other errors are reported');
});
