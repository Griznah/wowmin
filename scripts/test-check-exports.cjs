const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const checker = import(pathToFileURL(path.join(__dirname, 'check-exports.mjs')).href);

test('export check sorts files into 2D and 3D', async () => {
  const { exportKind } = await checker;
  assert.equal(exportKind('574.glb'), '3D');
  assert.equal(exportKind('574.scene.json'), '3D');
  assert.equal(exportKind('574.json'), '2D');
  assert.equal(exportKind('574-floor-1.jpg'), '2D');
  assert.equal(exportKind('index.json'), '2D');
});

test('export check compares JSON by value, ignoring generatedAt', async () => {
  const { jsonDifferences } = await checker;
  assert.deepEqual(jsonDifferences({ a: 1, generatedAt: 'x', b: [1, 2] }, { b: [1, 2], a: 1, generatedAt: 'y' }), []);
  assert.deepEqual(jsonDifferences({ a: 1, b: [1, 2] }, { a: 2, b: [1, 3] }), ['.a', '.b[1]']);
  assert.deepEqual(jsonDifferences({ a: {} }, { a: [] }), ['.a']);
});

test('export check reports each side separately', async () => {
  const { compareExports } = await checker;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wowmin-check-exports-'));
  const [left, right] = ['ref', 'new'].map((name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    return dir;
  });
  try {
    for (const dir of [left, right]) fs.writeFileSync(path.join(dir, '33.jpg'), 'same');
    fs.writeFileSync(path.join(left, '33.json'), JSON.stringify({ mapId: 33, generatedAt: 1 }));
    fs.writeFileSync(path.join(right, '33.json'), JSON.stringify({ mapId: 33, generatedAt: 2 }));
    fs.writeFileSync(path.join(left, '33.glb'), 'old');
    fs.writeFileSync(path.join(right, '33.glb'), 'newer');
    fs.writeFileSync(path.join(right, '33.scene.json'), '{}');
    const report = compareExports(left, right);
    assert.deepEqual(report['2D'], []);
    assert.deepEqual(report['3D'], ['33.glb: bytes differ (3 → 5)', `33.scene.json: only in ${right}`]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
