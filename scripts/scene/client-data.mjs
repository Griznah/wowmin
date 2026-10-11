// Opens a WoW client's Data directory and reads files from its MPQ archives,
// patches first.

import path from 'node:path';
import { createRequire } from 'node:module';

import { extractMpqFile, findMpqArchives } from '../extract-map-assets.mjs';

const require = createRequire(import.meta.url);
const { MpqArchive } = require('stormlib-js');

export function openClientData(dataDir, { warn = () => {} } = {}) {
  const archives = findMpqArchives(dataDir).reverse().flatMap((archivePath) => {
    try {
      return [MpqArchive.open(archivePath)];
    } catch (error) {
      warn(`Skipping ${path.basename(archivePath)}: ${error instanceof Error ? error.message : error}`);
      return [];
    }
  });
  if (!archives.length) throw new Error(`No MPQ archives found in ${dataDir}.`);
  return (fileName) => {
    for (const archive of archives) {
      const file = extractMpqFile(archive, [fileName]);
      if (file) return file;
    }
    return null;
  };
}
