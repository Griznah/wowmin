const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const archives = import(pathToFileURL(path.join(__dirname, 'client-archives.mjs')).href);

test('lettered locale patches override numbered patches in order', async () => {
  const { archivePriority } = await archives;
  const names = ['patch-enUS-N.MPQ', 'patch-3.MPQ', 'locale-enUS.MPQ', 'patch-enUS-M.MPQ'];
  assert.deepEqual(names.sort((a, b) => archivePriority(a) - archivePriority(b)),
    ['locale-enUS.MPQ', 'patch-3.MPQ', 'patch-enUS-M.MPQ', 'patch-enUS-N.MPQ']);
});
