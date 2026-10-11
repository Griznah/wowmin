import { fork, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Builds unit models (creatures, and characters with their gear), spell
// effect models, and spell art lookups on demand from the WoW client's Data
// directory, in a child process, and caches them under assets/models/. Needs
// WOWMIN_CLIENT_DATA; without it only what is already cached is served.

const BUILD_TIMEOUT_MS = 60000;
// Bumped when the converter's output changes, so models are rebuilt: built
// models live under v<version>/, and older ones are removed at startup.
// 2: spell effect points (hands, chest, overhead).
// 3: a head point; spell effect models and spell art lookups.
// 4: animations spell kits name (channelling, hit reactions, other casts).
// 5: a breath point (the mouth), for breath effects.
export const UNIT_MODEL_CACHE_VERSION = 5;
// Spell art (effect models and spell lookups) changes more often than unit
// models, so it has its own version and folder, art-v<version>/, and can be
// rebuilt without rebuilding every unit.
// 2: lookups name the model procedure 9 rains (Blizzard, Rain of Fire) and
// each kit's procedures.
// 3: effect clips named for what they are: Stand (start), Hold (idle),
// Decay (end), not Birth/Death.
export const SPELL_ART_CACHE_VERSION = 3;
const SPELL_ART_KINDS = new Set<UnitModelRequest['kind']>(['effect', 'visual', 'spell']);
const JSON_KINDS = new Set<UnitModelRequest['kind']>(['visual', 'spell']);
// A look that could not be built is not retried for this long.
const FAILURE_RETRY_MS = 10 * 60 * 1000;

interface PendingBuild {
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface UnitModelRequest {
  // 'effect' is a SpellVisualEffectName model; 'visual' a spell's art (JSON);
  // 'spell' a spell's name (JSON).
  kind: 'creature' | 'character' | 'effect' | 'visual' | 'spell';
  key: string;
  params: Record<string, unknown>;
}

// Parses /assets/models/<kind>/<key>.glb into a build request. Creatures are
// keyed by display ID, plus main hand, off hand, and ranged item display IDs
// when they carry weapons; characters by their look (see characterKey in
// scripts/scene/unit-model.mjs), which the worker validates.
export function parseUnitModelPath(urlPath: string): UnitModelRequest | null {
  const creature = urlPath.match(/^\/assets\/models\/creature\/((\d{1,7})(?:-(\d{1,7})\.(\d{1,7})\.(\d{1,7}))?)\.glb$/);
  if (creature) {
    const [, key, displayId, mainHand, offHand, ranged] = creature;
    const weapons = mainHand === undefined ? {} : { 15: Number(mainHand), 16: Number(offHand), 17: Number(ranged) };
    return { kind: 'creature', key, params: { displayId: Number(displayId), weapons } };
  }
  const effect = urlPath.match(/^\/assets\/models\/effect\/(\d{1,7})\.glb$/);
  if (effect) return { kind: 'effect', key: effect[1], params: { effectId: Number(effect[1]) } };
  const visual = urlPath.match(/^\/assets\/models\/visual\/(\d{1,7})\.json$/);
  if (visual) return { kind: 'visual', key: visual[1], params: { spellId: Number(visual[1]) } };
  const spell = urlPath.match(/^\/assets\/models\/spell\/(\d{1,7})\.json$/);
  if (spell) return { kind: 'spell', key: spell[1], params: { spellId: Number(spell[1]) } };
  const character = urlPath.match(/^\/assets\/models\/character\/([0-9][0-9.-]{0,199})\.glb$/);
  if (character) return { kind: 'character', key: character[1], params: { key: character[1] } };
  return null;
}

export class UnitModels {
  private worker: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingBuild>();
  private readonly building = new Map<string, Promise<boolean>>();
  private readonly failedAt = new Map<string, number>();

  constructor(private readonly cacheRoot: string, private readonly workerScript: string) {
    this.removeOldVersions();
  }

  get enabled(): boolean {
    return Boolean(process.env.WOWMIN_CLIENT_DATA);
  }

  pathFor(request: UnitModelRequest): string {
    const extension = JSON_KINDS.has(request.kind) ? 'json' : 'glb';
    const folder = SPELL_ART_KINDS.has(request.kind) ? `art-v${SPELL_ART_CACHE_VERSION}` : `v${UNIT_MODEL_CACHE_VERSION}`;
    return path.join(this.cacheRoot, folder, request.kind, `${request.key}.${extension}`);
  }

  // Only folders this cache made: older versions, the unversioned creature/
  // and character/ from before versioning, and spell art kept with the unit
  // models before it had its own version.
  private removeOldVersions(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.cacheRoot);
    } catch {
      return;
    }
    const old = entries.filter((entry) => entry === 'creature' || entry === 'character'
      || (/^v\d+$/.test(entry) && entry !== `v${UNIT_MODEL_CACHE_VERSION}`)
      || (/^art-v\d+$/.test(entry) && entry !== `art-v${SPELL_ART_CACHE_VERSION}`));
    for (const kind of SPELL_ART_KINDS) old.push(path.join(`v${UNIT_MODEL_CACHE_VERSION}`, kind));
    for (const entry of old) {
      try {
        fs.rmSync(path.join(this.cacheRoot, entry), { recursive: true, force: true });
      } catch (error) {
        console.warn(`Could not remove old cached models in ${entry}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  // Resolves to the cached file, building it first if needed; null if there
  // is no model for this look.
  async ensure(request: UnitModelRequest): Promise<string | null> {
    const filePath = this.pathFor(request);
    if (fs.existsSync(filePath)) return filePath;
    if (!this.enabled) return null;
    const id = `${request.kind}/${request.key}`;
    if (Date.now() - (this.failedAt.get(id) ?? 0) < FAILURE_RETRY_MS) return null;
    let build = this.building.get(id);
    if (!build) {
      build = this.build(request, filePath).finally(() => this.building.delete(id));
      this.building.set(id, build);
    }
    const ok = await build;
    if (!ok) this.failedAt.set(id, Date.now());
    return ok ? filePath : null;
  }

  private build(request: UnitModelRequest, outputPath: string): Promise<boolean> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false);
      }, BUILD_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      worker.send({ id, kind: request.kind, key: request.key, params: request.params, outputPath });
    });
  }

  private ensureWorker(): ChildProcess {
    if (this.worker) return this.worker;
    const worker = fork(this.workerScript, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    worker.on('message', (message: { id: number; ok: boolean; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (!message.ok && message.error) console.warn(`Unit model not built: ${message.error}`);
      pending.resolve(message.ok);
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null;
      if (code) console.warn(`Unit model worker exited with code ${code}.`);
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.resolve(false);
        this.pending.delete(id);
      }
    });
    this.worker = worker;
    return worker;
  }
}
