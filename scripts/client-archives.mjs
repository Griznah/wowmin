// Finds a WoW client's MPQ archives and reads files from them, patches first.
// Shared by the 2D map extraction, the 3D scene export and the model builds.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MpqArchive } = require('stormlib-js');

// The client's Data directory: the source itself, or its Data subfolder.
export function locateDataDir(sourcePath) {
  for (const candidate of [sourcePath, path.join(sourcePath, 'Data'), path.join(sourcePath, 'data')]) {
    if (path.basename(candidate).toLowerCase() !== 'data') continue;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

export function walkFiles(rootDir) {
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

export function archivePriority(filePath) {
  const name = path.basename(filePath).toLowerCase();
  if (/^common-2.*\.mpq$/.test(name)) return 15;
  if (/^common.*\.mpq$/.test(name)) return 10;
  if (/^expansion.*\.mpq$/.test(name)) return 20;
  if (/^lichking.*\.mpq$/.test(name)) return 25;
  if (/^locale-.*\.mpq$/.test(name)) return 30;
  const patch = name.match(/^patch(?:-[a-z]{4})?(?:-([0-9]+|[a-z]))?\.mpq$/);
  if (patch) {
    const suffix = patch[1] ?? '0';
    // Custom lettered patches must override base/numbered patches, with N
    // taking precedence over M. Previously they fell into the generic bucket.
    return 50 + (/^\d+$/.test(suffix) ? Number(suffix) : 100 + suffix.charCodeAt(0) - 97);
  }
  return 40;
}

export function findMpqArchives(dataDir) {
  const archives = [];
  const entries = walkFiles(dataDir);
  for (const entry of entries) {
    if (/\.mpq$/i.test(entry)) {
      archives.push(entry);
    }
  }

  archives.sort((a, b) => {
    const priorityDiff = archivePriority(a) - archivePriority(b);
    return priorityDiff !== 0 ? priorityDiff : a.localeCompare(b);
  });

  return archives;
}

export function extractMpqFile(archive, fileNames) {
  for (const fileName of fileNames) {
    try {
      return archive.extractFile(fileName);
    } catch {
      // keep trying alternate path forms
    }
  }
  return null;
}

// A reader over every archive in a client's Data directory, highest priority
// first, so patches override the base archives.
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
