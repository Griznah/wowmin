// Child process of the web server that builds unit models, spell effect
// models (GLB), spell art and name lookups (JSON), and icons (PNG) from the WoW client's Data
// directory on request, writing each to the cache path it is given. Messages in: { id, kind, key, params, outputPath }; out:
// { id, ok, error? }. Client archives are opened once, on the first request.

import fs from 'node:fs';
import path from 'node:path';

import { openClientData } from './client-data.mjs';
import { buildEffectGlb } from './effect-model.mjs';
import { buildIconPng } from './icons.mjs';
import { SpellVisuals } from './spell-visuals.mjs';
import { buildUnitGlb, UnitData } from './unit-model.mjs';

let unitData = null;
let spellVisuals = null;

function data() {
  if (!unitData) {
    const dataDir = process.env.WOWMIN_CLIENT_DATA;
    if (!dataDir) throw new Error('WOWMIN_CLIENT_DATA is not set.');
    unitData = new UnitData(openClientData(dataDir, { warn: (message) => console.warn(`[unit models] ${message}`) }));
  }
  return unitData;
}

function visuals() {
  spellVisuals ??= new SpellVisuals(data().readFile);
  return spellVisuals;
}

async function build(kind, params) {
  if (kind === 'visual') {
    const visual = visuals().forSpell(Number(params.spellId));
    return visual ? Buffer.from(JSON.stringify(visual)) : null;
  }
  if (kind === 'spell') {
    const spell = visuals().info(Number(params.spellId));
    return spell ? Buffer.from(JSON.stringify(spell)) : null;
  }
  if (kind === 'icon') return buildIconPng(data().readFile, params, visuals());
  if (kind === 'effect') {
    const modelName = visuals().effectModel(Number(params.effectId));
    return modelName ? buildEffectGlb(data().readFile, modelName) : null;
  }
  return buildUnitGlb(data(), kind, params);
}

process.on('message', async ({ id, kind, params, outputPath }) => {
  try {
    const output = await build(kind, params);
    if (!output) {
      process.send({ id, ok: false, error: kind === 'visual' ? `No art for spell ${params.spellId}.`
        : kind === 'spell' ? `No spell ${params.spellId}.` : kind === 'icon' ? 'No such icon.' : 'No model for this look.' });
      return;
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const partial = `${outputPath}.${process.pid}.partial`;
    fs.writeFileSync(partial, output);
    fs.renameSync(partial, outputPath);
    process.send({ id, ok: true });
  } catch (error) {
    process.send({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
