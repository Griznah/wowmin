#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import BLPFile from 'js-blp';
import { PNG } from 'pngjs';
import { archivePriority } from './extract-map-assets.mjs';

const require = createRequire(import.meta.url);
const { MpqArchive } = require('stormlib-js');

const RACES = [
  [1, 'human', 'Human'], [2, 'orc', 'Orc'], [3, 'dwarf', 'Dwarf'],
  [4, 'night-elf', 'NightElf'], [5, 'undead', 'Scourge'], [6, 'tauren', 'Tauren'],
  [7, 'gnome', 'Gnome'], [8, 'troll', 'Troll'], [10, 'blood-elf', 'BloodElf'],
  [11, 'draenei', 'Draenei'],
];

const CLASSES = [
  [1, 'warrior', 0, 0.25, 0, 0.25],
  [2, 'paladin', 0, 0.25, 0.5, 0.75],
  [3, 'hunter', 0, 0.25, 0.25, 0.5],
  [4, 'rogue', 0.49609375, 0.7421875, 0, 0.25],
  [5, 'priest', 0.49609375, 0.7421875, 0.25, 0.5],
  [6, 'death-knight', 0.25, 0.5, 0.5, 0.75],
  [7, 'shaman', 0.25, 0.49609375, 0.25, 0.5],
  [8, 'mage', 0.25, 0.49609375, 0, 0.25],
  [9, 'warlock', 0.7421875, 0.98828125, 0.25, 0.5],
  [11, 'druid', 0.7421875, 0.98828125, 0, 0.25],
];

const STATE_ICONS = {
  taxi: 'Interface\\Icons\\Ability_Mount_Gryphon_01.blp',
  mounted: 'Interface\\Icons\\Ability_Mount_RidingHorse.blp',
  combat: 'Interface\\Icons\\Ability_DualWield.blp',
  sap: 'Interface\\Icons\\Ability_Sap.blp',
  stun: 'Interface\\Icons\\Spell_Frost_Stun.blp',
  death: 'Interface\\Icons\\Spell_Shadow_DeathScream.blp',
  spirit: 'Interface\\Icons\\Spell_Holy_GreaterHeal.blp',
  resurrect: 'Interface\\Icons\\Spell_Holy_Resurrection.blp',
  flag: 'Interface\\Icons\\INV_BannerPVP_03.blp',
};

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(filePath) : [filePath];
  });
}

function locateDataDir(source) {
  for (const candidate of [source, path.join(source, 'Data'), path.join(source, 'data')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
      && walkFiles(candidate).some((file) => /\.mpq$/i.test(file))) return candidate;
  }
  return null;
}

export function decodeBlp(buffer) {
  const blp = new BLPFile(buffer);
  return { width: blp.width, height: blp.height, data: Buffer.from(blp.getPixels(0).raw) };
}

function writePng(filePath, image) {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

export function cropImage(image, left, right, top, bottom) {
  const x0 = Math.round(left * image.width);
  const x1 = Math.round(right * image.width);
  const y0 = Math.round(top * image.height);
  const y1 = Math.round(bottom * image.height);
  const width = x1 - x0;
  const height = y1 - y0;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    image.data.copy(data, y * width * 4, ((y0 + y) * image.width + x0) * 4,
      ((y0 + y) * image.width + x1) * 4);
  }
  return { width, height, data };
}

function parseArgs(argv) {
  const options = { source: process.env.npm_config_source, output: process.env.npm_config_output };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source' || arg === '-s') options.source = argv[++index];
    else if (arg === '--output' || arg === '-o') options.output = argv[++index];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!arg.startsWith('-') && !options.source) options.source = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.output ??= path.resolve(process.cwd(), 'assets/player-icons');
  return options;
}

function usage() {
  console.log(`WoWMin player icon extractor\n\nUsage:\n  npm run extract:icons -- --source /path/to/WoW\n\nOptions:\n  --source, -s   WoW 3.3.5a client root or Data directory\n  --output, -o   Output directory (default: assets/player-icons)\n  --help, -h     Show this help`);
}

function extractLatestFiles(dataDir, logicalPaths) {
  const wanted = new Map(logicalPaths.map((name) => [name.toLowerCase(), name]));
  const extracted = new Map();
  const archives = walkFiles(dataDir).filter((file) => /\.mpq$/i.test(file))
    .sort((left, right) => archivePriority(left) - archivePriority(right) || left.localeCompare(right));
  for (const archivePath of archives) {
    let archive;
    try {
      archive = MpqArchive.open(archivePath);
      const names = new Map(archive.getFileList().map((name) => [name.toLowerCase(), name]));
      for (const [key, logicalPath] of wanted) {
        const actualPath = names.get(key);
        if (!actualPath) continue;
        try {
          const data = archive.extractFile(actualPath);
          decodeBlp(data);
          extracted.set(logicalPath, data);
        } catch {
          // A lower-priority valid copy remains available when a patch entry is unreadable.
        }
      }
    } catch {
      // Skip archives StormLib cannot open.
    } finally {
      archive?.close();
    }
  }
  return extracted;
}

export function extractPlayerIcons(source, output) {
  const dataDir = locateDataDir(path.resolve(source));
  if (!dataDir) throw new Error(`Could not find MPQ archives under ${source}`);
  const portraitPaths = RACES.flatMap(([, , clientName]) => ['Male', 'Female'].map((gender) =>
    `Interface\\CharacterFrame\\TemporaryPortrait-${gender}-${clientName}.blp`));
  const classAtlasPath = 'Interface\\GLUES\\CHARACTERCREATE\\UI-CHARACTERCREATE-CLASSES.BLP';
  const requested = [...portraitPaths, classAtlasPath, ...Object.values(STATE_ICONS)];
  const files = extractLatestFiles(dataDir, requested);
  fs.mkdirSync(output, { recursive: true });

  const manifest = { version: 1, portraits: {}, classes: {}, states: {} };
  for (const [raceId, slug, clientName] of RACES) {
    for (const [genderId, genderName] of [[0, 'Male'], [1, 'Female']]) {
      const logicalPath = `Interface\\CharacterFrame\\TemporaryPortrait-${genderName}-${clientName}.blp`;
      const data = files.get(logicalPath);
      if (!data) continue;
      const fileName = `portrait-${slug}-${genderName.toLowerCase()}.png`;
      writePng(path.join(output, fileName), decodeBlp(data));
      manifest.portraits[`${raceId}:${genderId}`] = fileName;
    }
  }

  const classAtlas = files.get(classAtlasPath);
  if (classAtlas) {
    const image = decodeBlp(classAtlas);
    for (const [classId, slug, left, right, top, bottom] of CLASSES) {
      const fileName = `class-${slug}.png`;
      writePng(path.join(output, fileName), cropImage(image, left, right, top, bottom));
      manifest.classes[String(classId)] = fileName;
    }
  }

  for (const [state, logicalPath] of Object.entries(STATE_ICONS)) {
    const data = files.get(logicalPath);
    if (!data) continue;
    const fileName = `state-${state}.png`;
    writePng(path.join(output, fileName), decodeBlp(data));
    manifest.states[state] = fileName;
  }
  fs.writeFileSync(path.join(output, 'index.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  if (!options.source) throw new Error('Missing --source /path/to/WoW');
  const manifest = extractPlayerIcons(options.source, path.resolve(options.output));
  console.log(`Extracted ${Object.keys(manifest.portraits).length} portraits, ${Object.keys(manifest.classes).length} class icons, and ${Object.keys(manifest.states).length} state icons to ${path.resolve(options.output)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
