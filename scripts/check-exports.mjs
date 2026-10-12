#!/usr/bin/env node
// Compares two map export folders (e.g. assets/instances before and after a
// change) and reports the 2D map and 3D scene differences separately, so a
// fix to one can be shown not to touch the other.
//
//   node scripts/check-exports.mjs <reference-dir> <new-dir>
//
// 3D: <id>.glb and <id>.scene.json. 2D: everything else. JSON is compared by
// value (ignoring generatedAt), anything else byte for byte. Exits 1 when
// anything differs.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const IGNORED_KEYS = new Set(['generatedAt']);

export function exportKind(fileName) {
  return /\.glb$|\.scene\.json$/i.test(fileName) ? '3D' : '2D';
}

// The paths at which two JSON values differ, at most `limit` of them.
export function jsonDifferences(left, right, limit = 5, at = '') {
  if (Object.is(left, right)) return [];
  const bothObjects = left && right && typeof left === 'object' && typeof right === 'object'
    && Array.isArray(left) === Array.isArray(right);
  if (!bothObjects) return [at || '(root)'];
  const keys = new Set([...Object.keys(left), ...Object.keys(right)].filter((key) => !IGNORED_KEYS.has(key)));
  const differences = [];
  for (const key of keys) {
    differences.push(...jsonDifferences(left[key], right[key], limit - differences.length, `${at}${Array.isArray(left) ? `[${key}]` : `.${key}`}`));
    if (differences.length >= limit) break;
  }
  return differences;
}

export function compareExports(referenceDir, newDir) {
  const names = new Set([...fs.readdirSync(referenceDir), ...fs.readdirSync(newDir)]);
  const report = { '2D': [], '3D': [] };
  for (const name of [...names].sort()) {
    const left = path.join(referenceDir, name);
    const right = path.join(newDir, name);
    const kind = exportKind(name);
    if (!fs.existsSync(left)) { report[kind].push(`${name}: only in ${newDir}`); continue; }
    if (!fs.existsSync(right)) { report[kind].push(`${name}: only in ${referenceDir}`); continue; }
    if (name.endsWith('.json')) {
      const differences = jsonDifferences(JSON.parse(fs.readFileSync(left, 'utf8')), JSON.parse(fs.readFileSync(right, 'utf8')));
      if (differences.length) report[kind].push(`${name}: differs at ${differences.join(', ')}`);
      continue;
    }
    // Scenes run to tens of MB: only read files whose sizes match.
    const [sizeA, sizeB] = [fs.statSync(left).size, fs.statSync(right).size];
    if (sizeA !== sizeB || !fs.readFileSync(left).equals(fs.readFileSync(right))) {
      report[kind].push(`${name}: bytes differ (${sizeA} → ${sizeB})`);
    }
  }
  return report;
}

function main() {
  const [referenceDir, newDir] = process.argv.slice(2);
  if (!referenceDir || !newDir) {
    console.error('Usage: node scripts/check-exports.mjs <reference-dir> <new-dir>');
    process.exit(2);
  }
  const report = compareExports(referenceDir, newDir);
  for (const kind of ['2D', '3D']) {
    const lines = report[kind];
    console.log(`${kind}: ${lines.length ? `${lines.length} difference(s)` : 'identical'}`);
    for (const line of lines) console.log(`  ${line}`);
  }
  process.exit(report['2D'].length || report['3D'].length ? 1 : 0);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
