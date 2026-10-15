#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import jpeg from 'jpeg-js';
import BLPFile from 'js-blp';
import { PNG } from 'pngjs';

import { archiveReader, extractMpqFile, findMpqArchives, locateDataDir, openArchives, walkFiles } from './client-archives.mjs';
import { CONTINENTS, describeMaps, readMapTables, resolveMapTargets } from './map-catalog.mjs';
import { assertNpmValueOptionsHaveValues, readNpmConfigBoolean, readNpmConfigValue } from './npm-config.mjs';

// Audited common.MPQ map-530 edge textures. Both js-blp and Pillow show
// these opaque white/grey placeholders in the original BLP pixels. Gate by
// exact source content, not tile coordinates or generic colour heuristics:
// a corrected texture supplied by a different client/patch must remain intact.
const MAP_530_PLACEHOLDERS = new Map([
  ['87f8863a2dea243d8e17dc650f0cd169a66f16e6d466bff60562a3236dba9347', 'grey'],
  ['7338b4910f9e3dd2ab6d85aba69eb97703bb51576cbbae4e1a277b2cc452cc3a', 'grey'],
  ['3968917077e7068aa0d37a44e60881b77bc406904268835b5d3f6499f3bea75a', 'white'],
  ['c74344bc87317479ef1c746633f33cfa2048e8d30250dc98c1d1d409a320b3f7', 'white'],
  ['7d60609e9fe95938b26d53fa23319f932fea6a399970565fbe52a989445f9a49', 'white'],
  ['b4ac262ef4aafffa80c05bf1ba4c2c617b9f27f34d8f8b38edd2c343aa8a27d6', 'white'],
  ['e485773cb19adf5400e575ee95367358eb5d9bf40b9017643d28b59664e2e847', 'white'],
  ['9f6a07521b74b8518d90203bc2e1ec9f0e2244d15dc1ba96c3fd8e4c4ffa2227', 'white'],
  ['cefefcce1a2da4f8ef610f5d93e99138c6d3ea4e68473ecf7007f1672ef4726d', 'white'],
]);

export function cleanMap530Placeholder(image, mapId) {
  const kind = mapId === 530 ? MAP_530_PLACEHOLDERS.get(image.sourceHash) : undefined;
  if (!kind) return 0;
  let cleaned = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const r = image.data[offset];
    const g = image.data[offset + 1];
    const b = image.data[offset + 2];
    if (kind !== 'grey' && !(Math.min(r, g, b) >= 230 && Math.max(r, g, b) - Math.min(r, g, b) <= 12)) continue;
    // Composite the placeholder onto black before JPEG encoding, which does
    // not preserve alpha. Keep the real water pixels on the texture's edge.
    image.data.fill(0, offset, offset + 3);
    image.data[offset + 3] = 255;
    cleaned += 1;
  }
  return cleaned;
}

const DEFAULTS = {
  output: path.resolve(process.cwd(), 'assets/maps'),
  quality: 90,
  keepWorkspace: false,
};

const NPM_VALUE_OPTIONS = ['source', 'output', 'map', 'map_dir', 'workspace', 'quality'];

function printUsage() {
  console.log(`WoW Admin map extractor

Usage:
  npm run extract:maps -- --source /path/to/WoW
  npm run extract:maps -- --source /path/to/World/Minimaps
  npm run extract:maps --source=/path/to/WoW --all-instances

Options:
  --source, -s        WoW client root, Data dir, or extracted World/Minimaps dir
  --output, -o        Output directory (defaults to assets/maps or assets/instances for targeted modes)
  --map, -m           Extract only these map IDs (repeatable; no unrelated maps are regenerated)
  --all-instances     Extract every instance, raid, battleground, and arena from Map.dbc
  --map-dir           Client map directory override (single --map only)
  --workspace, -w     Temp/work directory used while extracting MPQs
  --quality, -q       JPEG quality (1-100, default: 90)
  --keep-workspace    Keep extracted minimap tiles instead of deleting temp files
  --help, -h          Show this message

Notes:
  - A plain positional path is also accepted as the source for npm convenience.
  - Without the standalone -- separator, value options must use equals syntax, e.g.
    npm run extract:maps --source=/path --output=./maps.
  - If --source already contains World/Minimaps, the script stitches tiles directly.
  - With --map or --all-instances, targets are resolved from DBFilesClient/Map.dbc.
    For an already-extracted minimap tree, also pass --map-dir when Map.dbc is unavailable.
  - If --source is a WoW 3.3.5a client, the script will try to extract World/Minimaps
    from MPQ archives using 7zz, 7z, or bsdtar if one is installed.
`);
}

export function parseArgs(argv) {
  assertNpmValueOptionsHaveValues(NPM_VALUE_OPTIONS);
  // 3D scenes have their own command now.
  if (readNpmConfigBoolean('scenes') || readNpmConfigValue('scene_texture_max')) {
    throw new Error('3D scenes are no longer made by extract:maps; run npm run extract:scenes.');
  }
  const npmOutput = readNpmConfigValue('output');
  const npmMaps = readNpmConfigValue('map');
  const options = {
    ...DEFAULTS,
    source: readNpmConfigValue('source'),
    output: npmOutput ?? DEFAULTS.output,
    outputExplicit: Boolean(npmOutput),
    mapIds: npmMaps ? npmMaps.split(',').map((value) => Number.parseInt(value, 10)) : [],
    allInstances: readNpmConfigBoolean('all_instances') ?? false,
    mapDir: readNpmConfigValue('map_dir'),
    workspace: readNpmConfigValue('workspace'),
    quality: Number.parseInt(readNpmConfigValue('quality') ?? String(DEFAULTS.quality), 10),
    keepWorkspace: readNpmConfigBoolean('keep_workspace') ?? DEFAULTS.keepWorkspace,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--source':
      case '-s':
        options.source = argv[++i];
        break;
      case '--output':
      case '-o':
        options.output = argv[++i];
        options.outputExplicit = true;
        break;
      case '--map':
      case '-m':
        options.mapIds.push(Number.parseInt(argv[++i] ?? '', 10));
        break;
      case '--all-instances':
        options.allInstances = true;
        break;
      case '--map-dir':
        options.mapDir = argv[++i];
        break;
      case '--workspace':
      case '-w':
        options.workspace = argv[++i];
        break;
      case '--quality':
      case '-q':
        options.quality = Number.parseInt(argv[++i] ?? '', 10);
        break;
      case '--keep-workspace':
        options.keepWorkspace = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown argument: ${arg}`);
        }
        positional.push(arg);
        break;
    }
  }

  if (!options.source && positional.length > 0) {
    [options.source] = positional;
  }
  if ((options.output === DEFAULTS.output || !options.output) && positional.length > 1) {
    [, options.output] = positional;
  }
  if (!options.workspace && positional.length > 2) {
    [, , options.workspace] = positional;
  }
  if ((options.quality === DEFAULTS.quality || Number.isNaN(options.quality)) && positional.length > 3) {
    options.quality = Number.parseInt(positional[3], 10);
  }

  if (positional.length > 4) {
    throw new Error(`Unexpected extra positional arguments: ${positional.slice(4).join(', ')}`);
  }

  if ((options.mapIds.length > 0 || options.allInstances) && !options.outputExplicit) {
    options.output = path.resolve(process.cwd(), 'assets/instances');
  } else if (options.output) {
    options.output = path.resolve(process.cwd(), options.output);
  }
  if (options.workspace) {
    options.workspace = path.resolve(process.cwd(), options.workspace);
  }
  if (options.source) {
    options.source = path.resolve(process.cwd(), options.source);
  }

  return options;
}

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exitCode = 1;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeName(name) {
  return name.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function pathExists(targetPath) {
  try {
    fs.accessSync(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function locateMinimapRoot(sourcePath) {
  const directCandidates = [
    sourcePath,
    path.join(sourcePath, 'World', 'Minimaps'),
    path.join(sourcePath, 'world', 'minimaps'),
    path.join(sourcePath, 'Data', 'World', 'Minimaps'),
    path.join(sourcePath, 'Data', 'world', 'minimaps'),
    path.join(sourcePath, 'data', 'World', 'Minimaps'),
    path.join(sourcePath, 'data', 'world', 'minimaps'),
  ];

  for (const candidate of directCandidates) {
    if (!pathExists(candidate)) {
      continue;
    }

    const stat = fs.statSync(candidate);
    if (!stat.isDirectory()) {
      continue;
    }

    const baseName = path.basename(candidate).toLowerCase();
    const parentName = path.basename(path.dirname(candidate)).toLowerCase();
    if (baseName === 'minimaps' && parentName === 'world') {
      return candidate;
    }
  }

  return null;
}

function findExtractionTool() {
  const candidates = ['7zz', '7z', 'bsdtar'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--help'], { stdio: 'ignore' });
    if (!probe.error) {
      return candidate;
    }
  }
  return null;
}

function canListMpqArchive(tool, archivePath) {
  if (tool === 'bsdtar') {
    const result = spawnSync(tool, ['-tf', archivePath], { encoding: 'utf8' });
    return !result.error && result.status === 0;
  }

  const result = spawnSync(tool, ['l', archivePath], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

function parseMd5TranslateTable(buffer) {
  const text = buffer.toString('utf8');
  const byDirectory = new Map();
  let currentDirectory = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith('dir: ')) {
      currentDirectory = line.slice(5).trim();
      if (!byDirectory.has(currentDirectory)) {
        byDirectory.set(currentDirectory, new Map());
      }
      continue;
    }

    if (!currentDirectory) {
      continue;
    }

    const parts = line.split(/\s+/);
    if (parts.length < 2) {
      continue;
    }

    const logicalPath = parts[0].replace(/\\/g, '/');
    const hashedName = parts[1];
    const logicalName = logicalPath.split('/').pop();
    if (!logicalName) {
      continue;
    }

    byDirectory.get(currentDirectory).set(logicalName, hashedName);
  }

  return byDirectory;
}

function canDecodeBlp(buffer) {
  try {
    const blp = new BLPFile(buffer);
    blp.getPixels(0);
    return true;
  } catch {
    return false;
  }
}

function tryExtractWorldMapArtwork(openedArchives, targets, workspaceDir) {
  const filesByFolder = new Map();
  for (const openedArchive of openedArchives) {
    for (const fileName of openedArchive.archive.getFileList()) {
      const match = fileName.match(/^interface\\worldmap\\([^\\]+)\\([^\\]+)\.blp$/i);
      if (!match) continue;
      const directory = match[1];
      const fileBase = match[2];
      if (!fileBase.toLowerCase().startsWith(directory.toLowerCase())) continue;
      const tileSuffix = fileBase.slice(directory.length);
      const folderKey = normalizeName(directory);
      if (!filesByFolder.has(folderKey)) {
        filesByFolder.set(folderKey, { directory, files: new Map(), floorFiles: new Map() });
      }
      const folder = filesByFolder.get(folderKey);
      const floorMatch = tileSuffix.match(/^(\d+)_(\d{1,2})$/);
      if (floorMatch) {
        const floorIndex = Number.parseInt(floorMatch[1], 10);
        const tileIndex = Number.parseInt(floorMatch[2], 10);
        if (tileIndex < 1 || tileIndex > 12) continue;
        if (!folder.floorFiles.has(floorIndex)) folder.floorFiles.set(floorIndex, new Map());
        const floorFiles = folder.floorFiles.get(floorIndex);
        if (!floorFiles.has(tileIndex)) floorFiles.set(tileIndex, []);
        floorFiles.get(tileIndex).push({ ...openedArchive, fileName });
        continue;
      }
      if (!/^\d{1,2}$/.test(tileSuffix)) continue;
      const tileIndex = Number.parseInt(tileSuffix, 10);
      if (tileIndex < 1 || tileIndex > 12) continue;
      if (!folder.files.has(tileIndex)) folder.files.set(tileIndex, []);
      folder.files.get(tileIndex).push({ ...openedArchive, fileName });
    }
  }

  const extractTiles = (files, targetDir) => {
    ensureDir(targetDir);
    let extracted = 0;
    for (const [tileIndex, candidates] of files.entries()) {
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const candidate = candidates[index];
        const data = extractMpqFile(candidate.archive, [candidate.fileName]);
        if (!data || !canDecodeBlp(data)) continue;
        fs.writeFileSync(path.join(targetDir, `${tileIndex}.blp`), data);
        extracted += 1;
        break;
      }
    }
    return extracted;
  };

  const resolvedTargets = [];
  const worldMapRoot = path.join(workspaceDir, 'Interface', 'WorldMap');
  for (const target of targets) {
    const aliases = [target.label, ...target.candidates].map(normalizeName);
    const folder = [...filesByFolder.values()].find((candidate) => aliases.includes(normalizeName(candidate.directory)));
    if (!folder) continue;

    const floorDefinitions = target.floors ?? [];
    const floors = [];
    for (const definition of floorDefinitions) {
      const files = folder.floorFiles.get(definition.floorIndex);
      if (!files?.size) continue;
      const floorDir = path.join(worldMapRoot, folder.directory, `floor-${definition.floorIndex}`);
      const extracted = extractTiles(files, floorDir);
      if (!extracted) continue;
      floors.push({ ...definition, folderPath: floorDir });
      console.log(`  ✓ ${folder.directory} floor ${definition.floorIndex}: extracted ${extracted} tile(s)`);
    }
    if (floors.length > 0) {
      resolvedTargets.push({
        ...target,
        candidates: [folder.directory],
        assetKind: 'worldmapFloors',
        floors,
      });
      continue;
    }

    if (folder.files.size === 0) continue;
    const targetDir = path.join(worldMapRoot, folder.directory);
    const extracted = extractTiles(folder.files, targetDir);
    if (!extracted) continue;
    console.log(`  ✓ ${folder.directory}: extracted ${extracted} Interface/WorldMap tile(s)`);
    resolvedTargets.push({
      ...target,
      candidates: [folder.directory],
      assetKind: 'worldmap',
      folderPath: targetDir,
    });
  }

  return resolvedTargets;
}

function tryExtractMinimapsWithStormlib(
  dataDir,
  archives,
  workspaceDir,
  requestedMapIds,
  mapDirOverride,
  allInstances,
) {
  if (archives.length === 0) return null;

  const openedArchives = openArchives(archives, (archivePath, message) =>
    console.warn(`  ! Skipping ${path.basename(archivePath)} for built-in MPQ extraction: ${message}`));
  try {
    if (openedArchives.length === 0) {
      return null;
    }

    const readFile = archiveReader(openedArchives);
    const trsBuffer = readFile('textures\\Minimap\\md5translate.trs');
    if (!trsBuffer) return null;

    const tables = readMapTables(readFile);
    let targets = CONTINENTS;
    if (requestedMapIds.length > 0 || allInstances) {
      if (mapDirOverride) {
        if (requestedMapIds.length !== 1) throw new Error('--map-dir can only be used with one --map value.');
        targets = [{ mapId: requestedMapIds[0], label: `Map ${requestedMapIds[0]}`, candidates: [mapDirOverride] }];
      } else {
        if (!tables.map) throw new Error('Could not extract DBFilesClient/Map.dbc; pass --map-dir explicitly.');
        targets = resolveMapTargets(tables, requestedMapIds, allInstances);
      }
    }
    targets = describeMaps(targets, tables, { aliases: !mapDirOverride });

    let resolvedTargets = [];
    if (requestedMapIds.length > 0 || allInstances) {
      resolvedTargets = tryExtractWorldMapArtwork(openedArchives, targets.filter((target) => target.mapType !== 0), workspaceDir);
      if (resolvedTargets.length > 0) {
        console.log(`• Using Interface/WorldMap artwork for ${resolvedTargets.length} map(s)`);
      }
    }
    const resolvedMapIds = new Set(resolvedTargets.map((target) => target.mapId));
    const minimapTargets = targets.filter((target) => !resolvedMapIds.has(target.mapId));
    if (minimapTargets.length === 0) {
      return { minimapRoot: workspaceDir, targets: resolvedTargets, missingTargets: [] };
    }

    const minimapIndex = new Map();
    for (const openedArchive of openedArchives) {
      const names = openedArchive.archive.getFileList();
      for (const name of names) {
        if (/^textures\\minimap\\[0-9a-f]{32}\.blp$/i.test(name)) {
          const key = name.toLowerCase();
          if (!minimapIndex.has(key)) {
            minimapIndex.set(key, []);
          }
          minimapIndex.get(key).push({
            archive: openedArchive.archive,
            fileName: name,
            archivePath: openedArchive.archivePath,
          });
        }
      }
    }

    const byDirectory = parseMd5TranslateTable(trsBuffer);
    const minimapRoot = path.join(workspaceDir, 'World', 'Minimaps');
    let extractedCount = 0;

    for (const continent of minimapTargets) {
      const directoryName = [...byDirectory.keys()].find((directory) =>
        continent.candidates.some((candidate) => normalizeName(candidate) === normalizeName(directory)));
      if (!directoryName) {
        continue;
      }

      const targetDir = path.join(minimapRoot, directoryName);
      ensureDir(targetDir);
      const tiles = byDirectory.get(directoryName);
      let targetExtractedCount = 0;

      for (const [logicalName, hashedName] of tiles.entries()) {
        const minimapKey = `textures\\minimap\\${hashedName}`.toLowerCase();
        const candidates = minimapIndex.get(minimapKey);
        if (!candidates || candidates.length === 0) {
          continue;
        }

        let selectedData = null;
        for (let index = candidates.length - 1; index >= 0; index -= 1) {
          const candidate = candidates[index];
          const data = extractMpqFile(candidate.archive, [candidate.fileName]);
          if (!data) {
            continue;
          }
          if (/\.blp$/i.test(logicalName) && !canDecodeBlp(data)) {
            console.warn(`  ! Skipping corrupt tile ${logicalName} from ${path.basename(candidate.archivePath)}`);
            continue;
          }
          selectedData = data;
          break;
        }

        if (!selectedData) {
          continue;
        }

        fs.writeFileSync(path.join(targetDir, logicalName), selectedData);
        extractedCount += 1;
        targetExtractedCount += 1;
      }

      console.log(`  ✓ ${directoryName}: ${targetExtractedCount}/${tiles.size} minimap tile(s) extracted`);
      if (targetExtractedCount === 0) continue;
      resolvedTargets.push({
        ...continent,
        candidates: [directoryName],
        assetKind: 'minimap',
        folderPath: targetDir,
      });
    }

    if (resolvedTargets.length === 0) return null;
    if (extractedCount > 0) console.log(`• Extracted ${extractedCount} minimap tile(s) directly from MPQ archives`);
    const resolvedIds = new Set(resolvedTargets.map((target) => target.mapId));
    const missingTargets = targets.filter((target) => !resolvedIds.has(target.mapId));
    if (missingTargets.length > 0) console.warn(`  ! No map artwork found for ${missingTargets.length} target(s)`);
    return { minimapRoot: workspaceDir, targets: resolvedTargets, missingTargets };
  } finally {
    for (const { archive } of openedArchives) {
      try {
        archive.close();
      } catch {
        // ignore close failures
      }
    }
  }
}

function runExtraction(tool, archivePath, workspaceDir) {
  if (tool === 'bsdtar') {
    return spawnSync(tool, [
      '-xf',
      archivePath,
      '-C',
      workspaceDir,
      '--wildcards',
      'World/Minimaps/*',
      'world/minimaps/*',
    ], {
      encoding: 'utf8',
    });
  }

  return spawnSync(tool, [
    'x',
    archivePath,
    'World\\Minimaps\\*',
    'world\\minimaps\\*',
    `-o${workspaceDir}`,
    '-y',
  ], {
    encoding: 'utf8',
  });
}

function extractMinimapsFromMpqs(sourcePath, workspaceDir, requestedMapIds, mapDirOverride, allInstances) {
  const dataDir = locateDataDir(sourcePath);
  if (!dataDir) {
    return null;
  }

  const archives = findMpqArchives(dataDir);
  if (archives.length === 0) {
    throw new Error(`No MPQ archives were found under ${dataDir}.`);
  }

  ensureDir(workspaceDir);

  const stormlibRoot = tryExtractMinimapsWithStormlib(
    dataDir,
    archives,
    workspaceDir,
    requestedMapIds,
    mapDirOverride,
    allInstances,
  );
  if (stormlibRoot) {
    return stormlibRoot;
  }

  const tool = findExtractionTool();
  if (!tool) {
    throw new Error('No usable built-in minimap extraction path was found, and no external archive extractor is available. Install a tool that can read WoW MPQ archives (recommended: 7zz), or point --source at an already extracted World/Minimaps directory.');
  }

  const probeArchive = archives[0];
  if (!canListMpqArchive(tool, probeArchive)) {
    throw new Error(
      `${tool} is installed but cannot read WoW MPQ archives on this system (${path.basename(probeArchive)} failed to open). ` +
      'The built-in MPQ reader also could not resolve usable minimap tiles from this client layout. Install 7zz, or extract World/Minimaps manually and point --source at that extracted folder.'
    );
  }

  console.log(`• Using ${tool} to extract minimaps from ${archives.length} MPQ archive(s)...`);
  let extractedAnything = false;

  for (const archive of archives) {
    const result = runExtraction(tool, archive, workspaceDir);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    const hasNoMatch = /No files to process|No such file|Cannot find archive|There is no such archive/i.test(output);

    if (result.error) {
      console.warn(`  ! Skipped ${path.basename(archive)}: ${result.error.message}`);
      continue;
    }

    if (result.status === 0) {
      extractedAnything = true;
      console.log(`  ✓ ${path.basename(archive)}`);
      continue;
    }

    if (hasNoMatch) {
      continue;
    }

    console.warn(`  ! ${path.basename(archive)} returned exit code ${result.status}.`);
  }

  if (!extractedAnything) {
    console.warn('  ! No archive reported extracted files. Checking the workspace anyway...');
  }

  const minimapRoot = locateMinimapRoot(workspaceDir);
  if (!minimapRoot) return null;
  if ((requestedMapIds.length > 0 || allInstances) && !mapDirOverride) {
    throw new Error('External MPQ extraction cannot resolve map targets automatically; use built-in MPQ support.');
  }
  const targets = requestedMapIds.length > 0
    ? [{ mapId: requestedMapIds[0], label: `Map ${requestedMapIds[0]}`, candidates: [mapDirOverride] }]
    : CONTINENTS;
  return { minimapRoot, targets, missingTargets: [] };
}

function findContinentFolder(minimapRoot, candidateNames) {
  const entries = fs.readdirSync(minimapRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const normalizedToEntry = new Map(entries.map((entry) => [normalizeName(entry.name), entry.name]));

  for (const candidate of candidateNames) {
    const match = normalizedToEntry.get(normalizeName(candidate));
    if (match) {
      return path.join(minimapRoot, match);
    }
  }

  return null;
}

function parseTileCoordinates(filePath) {
  const name = path.basename(filePath, path.extname(filePath));
  const patterns = [
    /(?:^|_)(\d{1,3})_(\d{1,3})$/i,
    /^map(\d{1,3})_(\d{1,3})$/i,
    /^[a-z0-9]+_(\d{1,3})_(\d{1,3})$/i,
  ];

  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (match) {
      return {
        tileX: Number.parseInt(match[1], 10),
        tileY: Number.parseInt(match[2], 10),
      };
    }
  }

  return null;
}

function decodeImage(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const buffer = fs.readFileSync(filePath);

  if (extension === '.blp') {
    const blp = new BLPFile(buffer);
    const pixels = blp.getPixels(0);
    return {
      width: blp.width,
      height: blp.height,
      data: Buffer.from(pixels.raw),
      sourceHash: createHash('sha256').update(buffer).digest('hex'),
    };
  }

  if (extension === '.png') {
    const png = PNG.sync.read(buffer);
    return {
      width: png.width,
      height: png.height,
      data: Buffer.from(png.data),
    };
  }

  if (extension === '.jpg' || extension === '.jpeg') {
    const jpg = jpeg.decode(buffer, { useTArray: true });
    return {
      width: jpg.width,
      height: jpg.height,
      data: Buffer.from(jpg.data),
    };
  }

  throw new Error(`Unsupported image format: ${filePath}`);
}

function collectTiles(folderPath, assetKind = 'minimap') {
  const files = walkFiles(folderPath)
    .filter((filePath) => /\.(blp|png|jpe?g)$/i.test(filePath))
    .sort((a, b) => a.localeCompare(b));

  const tiles = [];
  for (const filePath of files) {
    let coords;
    if (assetKind === 'worldmap') {
      const tileIndex = Number.parseInt(path.basename(filePath, path.extname(filePath)), 10);
      coords = Number.isInteger(tileIndex) && tileIndex > 0
        ? { tileX: (tileIndex - 1) % 4, tileY: Math.floor((tileIndex - 1) / 4) }
        : null;
    } else {
      coords = parseTileCoordinates(filePath);
    }
    if (!coords) {
      continue;
    }
    tiles.push({
      ...coords,
      filePath,
    });
  }

  return tiles;
}

function blitTile(target, targetWidth, targetHeight, tileData, tileWidth, tileHeight, offsetX, offsetY) {
  for (let y = 0; y < tileHeight; y += 1) {
    const destY = offsetY + y;
    if (destY < 0 || destY >= targetHeight) {
      continue;
    }

    for (let x = 0; x < tileWidth; x += 1) {
      const destX = offsetX + x;
      if (destX < 0 || destX >= targetWidth) {
        continue;
      }

      const sourceIndex = (y * tileWidth + x) * 4;
      const targetIndex = (destY * targetWidth + destX) * 4;

      target[targetIndex] = tileData[sourceIndex];
      target[targetIndex + 1] = tileData[sourceIndex + 1];
      target[targetIndex + 2] = tileData[sourceIndex + 2];
      target[targetIndex + 3] = tileData[sourceIndex + 3];
    }
  }
}

function stitchContinent(
  folderPath,
  continent,
  outputDir,
  quality,
  writeMetadata = false,
  outputBase = String(continent.mapId),
) {
  const assetKind = continent.assetKind ?? 'minimap';
  const tiles = collectTiles(folderPath, assetKind);
  if (tiles.length === 0) {
    throw new Error(`No tile files were found under ${folderPath}.`);
  }

  let minTileX = Number.POSITIVE_INFINITY;
  let minTileY = Number.POSITIVE_INFINITY;
  let maxTileX = Number.NEGATIVE_INFINITY;
  let maxTileY = Number.NEGATIVE_INFINITY;

  const decodedTiles = [];
  for (const tile of tiles) {
    try {
      const image = decodeImage(tile.filePath);
      if (assetKind === 'minimap' && cleanMap530Placeholder(image, continent.mapId)) {
        console.log(`  ✓ Removed audited source placeholder pixels from ${path.basename(tile.filePath)}`);
      }
      minTileX = Math.min(minTileX, tile.tileX);
      minTileY = Math.min(minTileY, tile.tileY);
      maxTileX = Math.max(maxTileX, tile.tileX);
      maxTileY = Math.max(maxTileY, tile.tileY);
      decodedTiles.push({
        ...tile,
        ...image,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`  ! Skipping unreadable tile ${path.basename(tile.filePath)}: ${errorMessage}`);
    }
  }

  if (decodedTiles.length === 0) {
    throw new Error(`No readable tile files were found under ${folderPath}.`);
  }

  const tileWidth = decodedTiles[0].width;
  const tileHeight = decodedTiles[0].height;

  for (const tile of decodedTiles) {
    if (tile.width !== tileWidth || tile.height !== tileHeight) {
      throw new Error(`Mixed tile sizes were found in ${folderPath}.`);
    }
  }

  const tiledWidth = (maxTileX - minTileX + 1) * tileWidth;
  const tiledHeight = (maxTileY - minTileY + 1) * tileHeight;
  // Interface/WorldMap art is stored as twelve 256px tiles, but the client
  // displays the logical 1002×668 map area and clips the unused tile edges.
  const outputWidth = assetKind === 'worldmap' ? Math.min(1002, tiledWidth) : tiledWidth;
  const outputHeight = assetKind === 'worldmap' ? Math.min(668, tiledHeight) : tiledHeight;
  const rgba = Buffer.alloc(outputWidth * outputHeight * 4, 0);

  for (const tile of decodedTiles) {
    const offsetX = (tile.tileX - minTileX) * tileWidth;
    const offsetY = (tile.tileY - minTileY) * tileHeight;
    blitTile(rgba, outputWidth, outputHeight, tile.data, tile.width, tile.height, offsetX, offsetY);
  }

  const encoded = jpeg.encode({ data: rgba, width: outputWidth, height: outputHeight }, quality);
  const outputPath = path.join(outputDir, `${outputBase}.jpg`);
  fs.writeFileSync(outputPath, encoded.data);

  let metadataPath = null;
  if (writeMetadata) {
    metadataPath = path.join(outputDir, `${continent.mapId}.json`);
    fs.writeFileSync(metadataPath, `${JSON.stringify({
      schemaVersion: 1,
      mapId: continent.mapId,
      label: continent.label,
      mapType: continent.mapType ?? null,
      mapTypeLabel: continent.mapTypeLabel ?? null,
      clientDirectory: path.basename(folderPath),
      image: `${outputBase}.jpg`,
      width: outputWidth,
      height: outputHeight,
      tileWidth,
      tileHeight,
      minTileX,
      minTileY,
      maxTileX,
      maxTileY,
      gridSize: 64,
      worldUnitsPerTile: 533.3333333333334,
      worldMapBounds: continent.worldMapBounds ?? null,
      projection: assetKind === 'worldmap'
        ? { type: 'worldMapArea' }
        : { type: 'minimapTiles' },
    }, null, 2)}\n`);
  }

  return {
    outputPath,
    tileCount: decodedTiles.length,
    width: outputWidth,
    height: outputHeight,
    minTileX,
    minTileY,
    maxTileX,
    maxTileY,
    folderPath,
    metadataPath,
  };
}

function stitchFloorTarget(target, outputDir, quality) {
  const floorSummaries = target.floors.map((floor) => ({
    floor,
    summary: stitchContinent(
      floor.folderPath,
      { ...target, assetKind: 'worldmap' },
      outputDir,
      quality,
      false,
      `${target.mapId}-floor-${floor.floorIndex}`,
    ),
  }));
  const primary = floorSummaries[0].summary;
  const metadataPath = path.join(outputDir, `${target.mapId}.json`);
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    schemaVersion: 2,
    mapId: target.mapId,
    label: target.label,
    mapType: target.mapType ?? null,
    mapTypeLabel: target.mapTypeLabel ?? null,
    clientDirectory: target.candidates[0] ?? null,
    projection: { type: 'dungeonFloors' },
    floors: floorSummaries.map(({ floor, summary }) => ({
      id: floor.id,
      floorIndex: floor.floorIndex,
      image: path.basename(summary.outputPath),
      width: summary.width,
      height: summary.height,
      bounds: floor.bounds,
      chunks: floor.chunks,
    })),
  }, null, 2)}\n`);
  return {
    ...primary,
    outputPath: primary.outputPath,
    metadataPath,
    tileCount: floorSummaries.reduce((total, floor) => total + floor.summary.tileCount, 0),
    floorCount: floorSummaries.length,
  };
}

async function main() {
  let options;

  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    printUsage();
    return;
  }

  if (options.help) {
    printUsage();
    return;
  }

  if (!options.source) {
    fail('Missing required --source argument.');
    printUsage();
    return;
  }

  if (!pathExists(options.source) || !fs.statSync(options.source).isDirectory()) {
    fail(`Source path does not exist or is not a directory: ${options.source}`);
    return;
  }

  if (!Number.isInteger(options.quality) || options.quality < 1 || options.quality > 100) {
    fail(`JPEG quality must be an integer between 1 and 100. Received: ${options.quality}`);
    return;
  }
  if (options.mapIds.some((mapId) => !Number.isInteger(mapId) || mapId < 0)) {
    fail(`Map IDs must be non-negative integers. Received: ${options.mapIds.join(', ')}`);
    return;
  }
  if (options.mapIds.length > 0 && options.allInstances) {
    fail('--map and --all-instances are mutually exclusive.');
    return;
  }
  if (options.mapDir && options.mapIds.length !== 1) {
    fail('--map-dir requires exactly one --map value.');
    return;
  }

  ensureDir(options.output);

  let workspaceDir = options.workspace;
  let tempWorkspaceCreated = false;
  let minimapRoot = locateMinimapRoot(options.source);
  let targets = CONTINENTS;
  let missingTargets = [];

  if (minimapRoot) {
    if (options.allInstances) {
      throw new Error('--all-instances requires a WoW client source so Map.dbc can be read.');
    }
    if (options.mapIds.length > 0) {
      if (!options.mapDir) throw new Error('When --source is an extracted World/Minimaps tree, --map-dir is required with --map.');
      targets = [{ mapId: options.mapIds[0], label: `Map ${options.mapIds[0]}`, candidates: [options.mapDir] }];
    }
    console.log(`• Found extracted minimaps at ${minimapRoot}`);
  } else {
    workspaceDir = workspaceDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wow-admin-minimaps-'));
    tempWorkspaceCreated = !options.workspace;
    const extraction = extractMinimapsFromMpqs(
      options.source,
      workspaceDir,
      options.mapIds,
      options.mapDir,
      options.allInstances,
    );
    if (!extraction?.minimapRoot) {
      throw new Error('Unable to find World/Minimaps after extraction. Point --source at an extracted minimap directory or verify your WoW client data files.');
    }
    minimapRoot = extraction.minimapRoot;
    targets = extraction.targets;
    missingTargets = extraction.missingTargets ?? [];
    console.log(`• Extracted minimaps into ${minimapRoot}`);
  }

  const summaries = [];

  const targetedExtraction = options.mapIds.length > 0 || options.allInstances;
  for (const continent of targets) {
    if (continent.assetKind === 'worldmapFloors') {
      console.log(`• Stitching ${continent.label} (${continent.floors.length} floors)...`);
      const summary = stitchFloorTarget(continent, options.output, options.quality);
      summaries.push({ continent, ...summary });
      console.log(`  ✓ Wrote ${summary.floorCount} floor image(s) (${summary.tileCount} tiles)`);
      continue;
    }

    const folderPath = continent.folderPath ?? findContinentFolder(minimapRoot, continent.candidates);
    if (!folderPath) {
      console.warn(`! Skipping ${continent.label}: could not find a minimap folder matching ${continent.candidates.join(', ')}`);
      continue;
    }

    console.log(`• Stitching ${continent.label} from ${path.basename(folderPath)}...`);
    const summary = stitchContinent(folderPath, continent, options.output, options.quality, targetedExtraction);
    summaries.push({ continent, ...summary });
    console.log(`  ✓ Wrote ${path.basename(summary.outputPath)} (${summary.width}×${summary.height}, ${summary.tileCount} tiles)`);
  }

  if (summaries.length === 0) {
    throw new Error('No maps were produced. Check the resolved minimap folder names and tile naming format.');
  }

  if (options.allInstances) {
    const indexPath = path.join(options.output, 'index.json');
    fs.writeFileSync(indexPath, `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      requestedMapCount: summaries.length + missingTargets.length,
      generatedMapCount: summaries.length,
      missingMapCount: missingTargets.length,
      maps: summaries.map((summary) => ({
        mapId: summary.continent.mapId,
        label: summary.continent.label,
        mapType: summary.continent.mapType,
        mapTypeLabel: summary.continent.mapTypeLabel,
        image: path.basename(summary.outputPath),
        metadata: path.basename(summary.metadataPath),
        width: summary.width,
        height: summary.height,
        projection: summary.continent.assetKind === 'worldmapFloors'
          ? 'dungeonFloors'
          : summary.continent.assetKind === 'worldmap' ? 'worldMapArea' : 'minimapTiles',
        floorCount: summary.floorCount ?? null,
      })),
      missingMaps: missingTargets.map((target) => ({
        mapId: target.mapId,
        label: target.label,
        mapType: target.mapType,
        mapTypeLabel: target.mapTypeLabel,
        clientDirectory: target.candidates[0] ?? null,
      })),
    }, null, 2)}\n`);
    console.log(`  ✓ Wrote ${indexPath}`);
  }

  console.log(`\nDone. Generated ${targetedExtraction ? 'targeted' : 'continent'} maps:`);
  for (const summary of summaries) {
    console.log(`  - ${summary.continent.label}: ${summary.outputPath}`);
  }

  if (workspaceDir && (options.keepWorkspace || options.workspace)) {
    console.log(`\nWorkspace retained at: ${workspaceDir}`);
  } else if (workspaceDir && (tempWorkspaceCreated || !options.keepWorkspace)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
