const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const output = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../renderer/scripts/utils/online-players.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
}).outputFiles[0].text;
const context = { module: { exports: {} } };
context.exports = context.module.exports;
vm.runInNewContext(output, context);
const { parseOnlineList, playersFromDatabase } = context.module.exports;

test('SOAP list header does not become a phantom Character row', () => {
  const message = '-[         Account][   Character][             IP][Map][Zone][Exp][GMLev]-\r\n'
    + '-[RNDBOT0][Jaspianus][127.0.0.1][530][3521][2][0]-\r\n'
    + '-[JELLY][Hero][127.0.0.1][0][1519][2][3]-';
  const players = parseOnlineList(message);
  assert.deepEqual(Array.from(players, (player) => player.name), ['Jaspianus', 'Hero']);
  assert.equal(players[0].isBot, true);
  assert.equal(players[1].isBot, false);
});

test('database rows provide level, race and class without pinfo commands', () => {
  const [player] = playersFromDatabase([{ name: 'Jaspianus', account: 'RNDBOT0', ip: '127.0.0.1',
    mapId: 530, zoneId: 3521, expansion: 2, gmLevel: 0, level: 80, raceId: 1, classId: 1, gender: 1 }]);
  assert.equal(player.level, '80');
  assert.equal(player.className, 'Warrior');
  assert.equal(player.race, 'Human');
  assert.equal(player.gender, 1);
});
