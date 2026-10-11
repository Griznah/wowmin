// Child process of the web server that builds unit models from the WoW
// client's Data directory on request, writing each GLB to the cache path it
// is given. Messages in: { id, kind, key, params, outputPath }; out:
// { id, ok, error? }. Client archives are opened once, on the first request.

import fs from 'node:fs';
import path from 'node:path';

import { openClientData } from './client-data.mjs';
import { buildUnitGlb, UnitData } from './unit-model.mjs';

let unitData = null;

function data() {
  if (!unitData) {
    const dataDir = process.env.WOWMIN_CLIENT_DATA;
    if (!dataDir) throw new Error('WOWMIN_CLIENT_DATA is not set.');
    unitData = new UnitData(openClientData(dataDir, { warn: (message) => console.warn(`[unit models] ${message}`) }));
  }
  return unitData;
}

process.on('message', async ({ id, kind, params, outputPath }) => {
  try {
    const glb = await buildUnitGlb(data(), kind, params);
    if (!glb) {
      process.send({ id, ok: false, error: 'No model for this look.' });
      return;
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const partial = `${outputPath}.${process.pid}.partial`;
    fs.writeFileSync(partial, glb);
    fs.renameSync(partial, outputPath);
    process.send({ id, ok: true });
  } catch (error) {
    process.send({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
