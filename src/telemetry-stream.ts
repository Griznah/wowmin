import * as dgram from 'dgram';

import type {
  StreamAppearance, StreamAppearanceUpdate, StreamAuraCategory, StreamBotDecision, StreamCombatEvent, StreamCombatEventKind,
  StreamCombatEventUpdate, StreamUnitAuras, StreamUnitAuraUpdate, StreamBotUpdate, StreamCreatureSample, StreamCreatureUpdate, StreamFrame, StreamListeners,
  StreamPath, StreamPathUpdate, StreamPlayerSample, StreamStatus,
} from './types/electron';

// Receives the mod-wowmin-telemetry UDP position stream. A session streams only
// while it is watched: every RENEW_INTERVAL_MS the subscription is renewed with
// "wowmin stream <mapId> <instanceId>" over SOAP, and the module stops sending
// when renewals stop. The datagram layout is documented in WowMinTelemetry.cpp.

export interface StreamDatagram {
  mapId: number;
  instanceId: number;
  sequence: number;
  serverTimeMs: number;
  part: number;
  partCount: number;
  players: StreamPlayerSample[];
}

const MAGIC = 'WMS1';
const PATH_MAGIC = 'WMP1';
const CREATURE_MAGIC = 'WMC1';
const BOT_MAGIC = 'WMB1';
const APPEARANCE_MAGIC = 'WMA1';
const COMBAT_MAGIC = 'WME1';
const UNIT_AURA_MAGIC = 'WMU1';
const VERSION = 1;
const HEADER_SIZE = 28;
const PLAYER_SIZE = 30;
// Path, creature, and bot datagrams share a 24-byte header.
const PATH_HEADER_SIZE = 24;
const PATH_ENTRY_SIZE = 12;
const CREATURE_SIZE = 36;
const BOT_SIZE = 36;
const BOT_ACTION_SIZE = 12;
const APPEARANCE_SIZE = 108;
const COMBAT_EVENT_SIZE = 44;
const COMBAT_EVENT_KINDS: Array<StreamCombatEventKind | undefined> = [
  undefined, 'castStart', 'castGo', 'castCancel', 'auraApply', 'auraRemove', 'swing', 'damage', 'heal',
];
const AURA_CATEGORIES: Array<StreamAuraCategory | null> = [null, 'crowdControl', 'shield', 'defensive', 'offensive'];
const EQUIPMENT_SLOTS = 19;
const BOT_STATES: StreamBotDecision['state'][] = ['combat', 'idle', 'dead'];
const RENEW_INTERVAL_MS = 3000;
// A frame this old means the module restarted or the stream lapsed, so accept
// whatever sequence comes next rather than waiting to catch up.
const SEQUENCE_RESET_MS = 2000;
// No frame for this long: the stream has lapsed (status back to 'starting').
const STREAM_LAPSED_MS = 3000;
// Still nothing this long after watching or the last frame: report it as
// unavailable (module disabled, or datagrams not reaching this port).
const STREAM_UNAVAILABLE_MS = 8000;

export function parseStreamDatagram(buffer: Buffer): StreamDatagram | null {
  if (buffer.length < HEADER_SIZE || buffer.toString('latin1', 0, 4) !== MAGIC || buffer.readUInt8(4) !== VERSION) {
    return null;
  }
  const partCount = buffer.readUInt8(6);
  const part = buffer.readUInt8(5);
  if (!partCount || part >= partCount) return null;
  const playerCount = buffer.readUInt16LE(24);
  const players: StreamPlayerSample[] = [];
  let offset = HEADER_SIZE;
  for (let index = 0; index < playerCount; index += 1) {
    if (offset + PLAYER_SIZE > buffer.length) return null;
    const nameLength = buffer.readUInt8(offset + 25);
    if (offset + PLAYER_SIZE + nameLength > buffer.length) return null;
    const flags = buffer.readUInt8(offset + 23);
    players.push({
      guid: buffer.readUInt32LE(offset),
      x: buffer.readFloatLE(offset + 4),
      y: buffer.readFloatLE(offset + 8),
      z: buffer.readFloatLE(offset + 12),
      orientation: buffer.readFloatLE(offset + 16),
      healthPct: buffer.readUInt8(offset + 20),
      powerPct: buffer.readUInt8(offset + 21),
      powerType: buffer.readInt8(offset + 22),
      alive: Boolean(flags & 1),
      inCombat: Boolean(flags & 2),
      waitingForResurrect: Boolean(flags & 4),
      stateFlags: buffer.readUInt8(offset + 24),
      wmoGroupId: buffer.readInt32LE(offset + 26),
      name: buffer.toString('utf8', offset + PLAYER_SIZE, offset + PLAYER_SIZE + nameLength),
    });
    offset += PLAYER_SIZE + nameLength;
  }
  return {
    mapId: buffer.readUInt32LE(8),
    instanceId: buffer.readUInt32LE(12),
    sequence: buffer.readUInt32LE(16),
    serverTimeMs: buffer.readUInt32LE(20),
    part,
    partCount,
    players,
  };
}

export interface PathDatagram {
  mapId: number;
  instanceId: number;
  serverTimeMs: number;
  paths: Array<Omit<StreamPath, 'name'>>;
}

function readEntryHeader(buffer: Buffer, magic: string): { mapId: number; instanceId: number; serverTimeMs: number; count: number } | null {
  if (buffer.length < PATH_HEADER_SIZE || buffer.toString('latin1', 0, 4) !== magic || buffer.readUInt8(4) !== VERSION) {
    return null;
  }
  return {
    mapId: buffer.readUInt32LE(8),
    instanceId: buffer.readUInt32LE(12),
    serverTimeMs: buffer.readUInt32LE(16),
    count: buffer.readUInt16LE(20),
  };
}

export function parsePathDatagram(buffer: Buffer): PathDatagram | null {
  const header = readEntryHeader(buffer, PATH_MAGIC);
  if (!header) return null;
  const paths: PathDatagram['paths'] = [];
  let offset = PATH_HEADER_SIZE;
  for (let index = 0; index < header.count; index += 1) {
    if (offset + PATH_ENTRY_SIZE > buffer.length) return null;
    const pointCount = buffer.readUInt8(offset + 8);
    if (offset + PATH_ENTRY_SIZE + pointCount * 12 > buffer.length) return null;
    const points: StreamPath['points'] = [];
    for (let point = 0; point < pointCount; point += 1) {
      const at = offset + PATH_ENTRY_SIZE + point * 12;
      points.push([buffer.readFloatLE(at), buffer.readFloatLE(at + 4), buffer.readFloatLE(at + 8)]);
    }
    const flags = buffer.readUInt8(offset + 9);
    paths.push({
      guid: buffer.readUInt32LE(offset),
      splineId: buffer.readUInt32LE(offset + 4),
      truncated: Boolean(flags & 1),
      creature: Boolean(flags & 2),
      points,
    });
    offset += PATH_ENTRY_SIZE + pointCount * 12;
  }
  return { mapId: header.mapId, instanceId: header.instanceId, serverTimeMs: header.serverTimeMs, paths };
}

export function parseCreatureDatagram(buffer: Buffer): StreamCreatureUpdate | null {
  const header = readEntryHeader(buffer, CREATURE_MAGIC);
  if (!header || buffer.length < PATH_HEADER_SIZE + header.count * CREATURE_SIZE) return null;
  const creatures: StreamCreatureSample[] = [];
  for (let index = 0; index < header.count; index += 1) {
    const offset = PATH_HEADER_SIZE + index * CREATURE_SIZE;
    const flags = buffer.readUInt8(offset + 25);
    creatures.push({
      guid: buffer.readUInt32LE(offset),
      entry: buffer.readUInt32LE(offset + 4),
      x: buffer.readFloatLE(offset + 8),
      y: buffer.readFloatLE(offset + 12),
      z: buffer.readFloatLE(offset + 16),
      orientation: buffer.readFloatLE(offset + 20),
      healthPct: buffer.readUInt8(offset + 24),
      alive: Boolean(flags & 1),
      inCombat: Boolean(flags & 2),
      hostile: Boolean(flags & 4),
      boss: Boolean(flags & 8),
      playerControlled: Boolean(flags & 16),
      targetIsPlayer: Boolean(flags & 32),
      scenery: Boolean(flags & 64),
      targetGuid: buffer.readUInt32LE(offset + 28),
      wmoGroupId: buffer.readInt32LE(offset + 32),
    });
  }
  return { mapId: header.mapId, instanceId: header.instanceId, serverTimeMs: header.serverTimeMs, creatures };
}

export interface BotDatagram {
  mapId: number;
  instanceId: number;
  serverTimeMs: number;
  bots: Array<Omit<StreamBotDecision, 'name'>>;
}

export function parseBotDatagram(buffer: Buffer): BotDatagram | null {
  const header = readEntryHeader(buffer, BOT_MAGIC);
  if (!header) return null;
  const bots: BotDatagram['bots'] = [];
  let offset = PATH_HEADER_SIZE;
  for (let index = 0; index < header.count; index += 1) {
    if (offset + BOT_SIZE > buffer.length) return null;
    const flags = buffer.readUInt8(offset + 7);
    const motionType = buffer.readUInt8(offset + 5);
    const strategiesLength = buffer.readUInt16LE(offset + 32);
    const actionCount = buffer.readUInt8(offset + 34);
    let at = offset + BOT_SIZE;
    if (at + strategiesLength > buffer.length) return null;
    const strategies = buffer.toString('utf8', at, at + strategiesLength).split(',').filter(Boolean);
    at += strategiesLength;
    const actions: StreamBotDecision['actions'] = [];
    for (let action = 0; action < actionCount; action += 1) {
      if (at + BOT_ACTION_SIZE > buffer.length) return null;
      const nameLength = buffer.readUInt8(at);
      if (at + BOT_ACTION_SIZE + nameLength > buffer.length) return null;
      actions.push({
        repeats: buffer.readUInt16LE(at + 2),
        relevance: buffer.readFloatLE(at + 4),
        ageMs: buffer.readUInt32LE(at + 8),
        name: buffer.toString('utf8', at + BOT_ACTION_SIZE, at + BOT_ACTION_SIZE + nameLength),
      });
      at += BOT_ACTION_SIZE + nameLength;
    }
    bots.push({
      guid: buffer.readUInt32LE(offset),
      state: BOT_STATES[buffer.readUInt8(offset + 4)] ?? 'idle',
      motionType: motionType === 255 ? null : motionType,
      movePriority: buffer.readUInt8(offset + 6),
      moveTarget: flags & 1
        ? {
          x: buffer.readFloatLE(offset + 8),
          y: buffer.readFloatLE(offset + 12),
          z: buffer.readFloatLE(offset + 16),
          ageMs: buffer.readUInt32LE(offset + 20),
        }
        : null,
      motionTargetGuid: buffer.readUInt32LE(offset + 24),
      motionTargetIsPlayer: Boolean(flags & 2),
      targetGuid: buffer.readUInt32LE(offset + 28),
      targetIsPlayer: Boolean(flags & 4),
      strategies,
      actions,
    });
    offset = at;
  }
  return { mapId: header.mapId, instanceId: header.instanceId, serverTimeMs: header.serverTimeMs, bots };
}

export function parseAppearanceDatagram(buffer: Buffer): StreamAppearanceUpdate | null {
  const header = readEntryHeader(buffer, APPEARANCE_MAGIC);
  if (!header || buffer.length < PATH_HEADER_SIZE + header.count * APPEARANCE_SIZE) return null;
  const units: StreamAppearance[] = [];
  for (let index = 0; index < header.count; index += 1) {
    const offset = PATH_HEADER_SIZE + index * APPEARANCE_SIZE;
    const flags = buffer.readUInt8(offset + 4);
    const items: number[] = [];
    for (let slot = 0; slot < EQUIPMENT_SLOTS; slot += 1) items.push(buffer.readUInt32LE(offset + 28 + slot * 4));
    units.push({
      guid: buffer.readUInt32LE(offset),
      creature: Boolean(flags & 1),
      helmHidden: Boolean(flags & 2),
      cloakHidden: Boolean(flags & 4),
      race: buffer.readUInt8(offset + 5),
      gender: buffer.readUInt8(offset + 6),
      classId: buffer.readUInt8(offset + 7),
      skin: buffer.readUInt8(offset + 8),
      face: buffer.readUInt8(offset + 9),
      hairStyle: buffer.readUInt8(offset + 10),
      hairColor: buffer.readUInt8(offset + 11),
      facialStyle: buffer.readUInt8(offset + 12),
      sheathState: buffer.readUInt8(offset + 13),
      scale: buffer.readUInt16LE(offset + 14) / 1000,
      displayId: buffer.readUInt32LE(offset + 16),
      nativeDisplayId: buffer.readUInt32LE(offset + 20),
      mountDisplayId: buffer.readUInt32LE(offset + 24),
      items,
      mainHandType: buffer.readUInt8(offset + 104),
      mainHandSubclass: buffer.readUInt8(offset + 105),
      offHandType: buffer.readUInt8(offset + 106),
      rangedSubclass: buffer.readUInt8(offset + 107),
    });
  }
  return { mapId: header.mapId, instanceId: header.instanceId, serverTimeMs: header.serverTimeMs, units };
}

export function parseCombatEventDatagram(buffer: Buffer): StreamCombatEventUpdate | null {
  const header = readEntryHeader(buffer, COMBAT_MAGIC);
  if (!header || buffer.length < PATH_HEADER_SIZE + header.count * COMBAT_EVENT_SIZE) return null;
  const events: StreamCombatEvent[] = [];
  for (let index = 0; index < header.count; index += 1) {
    const offset = PATH_HEADER_SIZE + index * COMBAT_EVENT_SIZE;
    // Kinds from a newer module are skipped.
    const kind = COMBAT_EVENT_KINDS[buffer.readUInt8(offset)];
    if (!kind) continue;
    const flags = buffer.readUInt8(offset + 1);
    events.push({
      kind,
      sourceCreature: Boolean(flags & 1),
      targetCreature: Boolean(flags & 2),
      area: Boolean(flags & 4),
      channeled: Boolean(flags & 8),
      periodic: Boolean(flags & 32),
      helpful: Boolean(flags & 64),
      triggered: Boolean(flags & 128),
      schoolMask: buffer.readUInt8(offset + 2),
      auraCategory: AURA_CATEGORIES[buffer.readUInt8(offset + 3)] ?? null,
      sourceGuid: buffer.readUInt32LE(offset + 4),
      targetGuid: buffer.readUInt32LE(offset + 8),
      spellId: buffer.readUInt32LE(offset + 12),
      value: buffer.readUInt32LE(offset + 16),
      missileSpeed: buffer.readFloatLE(offset + 20),
      radius: buffer.readFloatLE(offset + 24),
      point: flags & 16
        ? [buffer.readFloatLE(offset + 28), buffer.readFloatLE(offset + 32), buffer.readFloatLE(offset + 36)]
        : null,
      ageMs: buffer.readUInt16LE(offset + 40),
      persistentArea: Boolean(buffer.readUInt16LE(offset + 42) & 1),
    });
  }
  return {
    mapId: header.mapId, instanceId: header.instanceId, serverTimeMs: header.serverTimeMs,
    dropped: buffer.readUInt16LE(22), events,
  };
}

export function parseUnitAuraDatagram(buffer: Buffer): StreamUnitAuraUpdate | null {
  const header = readEntryHeader(buffer, UNIT_AURA_MAGIC);
  if (!header) return null;
  const units: StreamUnitAuras[] = [];
  let offset = PATH_HEADER_SIZE;
  for (let index = 0; index < header.count; index += 1) {
    if (offset + 8 > buffer.length) return null;
    const count = buffer.readUInt8(offset + 5);
    if (offset + 8 + count * 4 > buffer.length) return null;
    const spellIds: number[] = [];
    for (let aura = 0; aura < count; aura += 1) spellIds.push(buffer.readUInt32LE(offset + 8 + aura * 4));
    units.push({ guid: buffer.readUInt32LE(offset), creature: Boolean(buffer.readUInt8(offset + 4) & 1), spellIds });
    offset += 8 + count * 4;
  }
  return { mapId: header.mapId, instanceId: header.instanceId, serverTimeMs: header.serverTimeMs, units };
}

type CommandRunner = (command: string) => Promise<{ success: boolean; message: string }>;

interface WatchedSession {
  mapId: number;
  instanceId: number;
  listeners: Set<StreamListeners>;
  status: StreamStatus;
  // Player names by guid, from the latest frames, for naming paths.
  names: Map<number, string>;
  // Reassembly of the snapshot currently arriving.
  sequence: number;
  parts: Map<number, StreamPlayerSample[]>;
  lastFrameAt: number;
  watchedAt: number;
}

export class TelemetryStream {
  private socket: dgram.Socket | null = null;
  private readonly sessions = new Map<string, WatchedSession>();
  private renewTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly runCommand: CommandRunner,
    private readonly bindHost: string,
    private readonly bindPort: number,
  ) {}

  // Starts receiving for a session; returns a function that stops watching.
  watch(mapId: number, instanceId: number, listeners: StreamListeners): () => void {
    const key = `${mapId}:${instanceId}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        mapId, instanceId, listeners: new Set(),
        status: 'starting', names: new Map(), sequence: 0, parts: new Map(), lastFrameAt: 0, watchedAt: Date.now(),
      };
      this.sessions.set(key, session);
    }
    session.listeners.add(listeners);
    listeners.onStatus(session.status);
    this.ensureRunning();
    void this.renew(session);

    return () => {
      session.listeners.delete(listeners);
      if (!session.listeners.size) this.sessions.delete(key);
      if (!this.sessions.size) this.stop();
    };
  }

  private ensureRunning(): void {
    if (!this.socket) {
      const socket = dgram.createSocket('udp4');
      socket.on('message', (message) => this.receive(message));
      socket.on('error', (error) => {
        console.error(`Telemetry stream socket error on ${this.bindHost}:${this.bindPort}: ${error.message}`);
        for (const session of this.sessions.values()) this.setStatus(session, 'unavailable');
        socket.close();
        if (this.socket === socket) this.socket = null;
      });
      socket.bind(this.bindPort, this.bindHost);
      this.socket = socket;
    }
    if (!this.renewTimer) {
      this.renewTimer = setInterval(() => {
        const now = Date.now();
        for (const session of this.sessions.values()) {
          const quietFor = now - Math.max(session.watchedAt, session.lastFrameAt);
          if (session.status === 'streaming' && quietFor > STREAM_LAPSED_MS) this.setStatus(session, 'starting');
          if (session.status === 'starting' && quietFor > STREAM_UNAVAILABLE_MS) this.setStatus(session, 'unavailable');
          void this.renew(session);
        }
      }, RENEW_INTERVAL_MS);
    }
  }

  private stop(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  private async renew(session: WatchedSession): Promise<void> {
    try {
      const result = await this.runCommand(`wowmin stream ${session.mapId} ${session.instanceId}`);
      const reply = result.success ? result.message.split(/\r?\n/).find((line) => line.startsWith('WSTREAM|')) : null;
      // An older module has no stream command; treat that as unavailable too.
      if (!reply || reply === 'WSTREAM|disabled' || reply === 'WSTREAM|full') this.setStatus(session, 'unavailable');
    } catch {
      this.setStatus(session, 'unavailable');
    }
  }

  private receive(message: Buffer): void {
    const magic = message.toString('latin1', 0, 4);
    if (magic === PATH_MAGIC) {
      this.receivePaths(message);
      return;
    }
    if (magic === CREATURE_MAGIC) {
      this.receiveCreatures(message);
      return;
    }
    if (magic === BOT_MAGIC) {
      this.receiveBots(message);
      return;
    }
    if (magic === APPEARANCE_MAGIC) {
      this.receiveAppearances(message);
      return;
    }
    if (magic === COMBAT_MAGIC) {
      this.receiveCombatEvents(message);
      return;
    }
    if (magic === UNIT_AURA_MAGIC) {
      this.receiveUnitAuras(message);
      return;
    }
    const datagram = parseStreamDatagram(message);
    if (!datagram) return;
    const session = this.sessions.get(`${datagram.mapId}:${datagram.instanceId}`);
    if (!session) return;

    const now = Date.now();
    if (datagram.sequence !== session.sequence) {
      const stale = now - session.lastFrameAt > SEQUENCE_RESET_MS;
      if (datagram.sequence < session.sequence && !stale) return;
      session.sequence = datagram.sequence;
      session.parts = new Map();
    }
    session.parts.set(datagram.part, datagram.players);
    if (session.parts.size < datagram.partCount) return;

    const players = [...session.parts.entries()].sort(([left], [right]) => left - right).flatMap(([, part]) => part);
    session.parts = new Map();
    session.lastFrameAt = now;
    // Mark the sequence complete so late duplicates of it are ignored.
    session.sequence = datagram.sequence + 1;
    this.setStatus(session, 'streaming');
    session.names = new Map(players.map((player) => [player.guid, player.name]));
    const frame: StreamFrame = {
      mapId: datagram.mapId,
      instanceId: datagram.instanceId,
      sequence: datagram.sequence,
      serverTimeMs: datagram.serverTimeMs,
      players,
    };
    for (const listener of session.listeners) listener.onFrame(frame);
  }

  // Player paths are named from the latest frame; those for players not yet
  // seen in one are dropped, as the module re-sends paths every second.
  private receivePaths(message: Buffer): void {
    const datagram = parsePathDatagram(message);
    if (!datagram) return;
    const session = this.sessions.get(`${datagram.mapId}:${datagram.instanceId}`);
    if (!session) return;
    const paths = datagram.paths.flatMap((path) => {
      if (path.creature) return [{ ...path, name: '' }];
      const name = session.names.get(path.guid);
      return name ? [{ ...path, name }] : [];
    });
    if (!paths.length) return;
    const update: StreamPathUpdate = {
      mapId: datagram.mapId, instanceId: datagram.instanceId, serverTimeMs: datagram.serverTimeMs, paths,
    };
    for (const listener of session.listeners) listener.onPaths?.(update);
  }

  private receiveCreatures(message: Buffer): void {
    const update = parseCreatureDatagram(message);
    if (!update?.creatures.length) return;
    const session = this.sessions.get(`${update.mapId}:${update.instanceId}`);
    if (!session) return;
    for (const listener of session.listeners) listener.onCreatures?.(update);
  }

  // Named like player paths; bots not yet seen in a frame are dropped.
  private receiveBots(message: Buffer): void {
    const datagram = parseBotDatagram(message);
    if (!datagram) return;
    const session = this.sessions.get(`${datagram.mapId}:${datagram.instanceId}`);
    if (!session) return;
    const bots = datagram.bots.flatMap((bot) => {
      const name = session.names.get(bot.guid);
      return name ? [{ ...bot, name }] : [];
    });
    if (!bots.length) return;
    const update: StreamBotUpdate = {
      mapId: datagram.mapId, instanceId: datagram.instanceId, serverTimeMs: datagram.serverTimeMs, bots,
    };
    for (const listener of session.listeners) listener.onBots?.(update);
  }

  private receiveAppearances(message: Buffer): void {
    const update = parseAppearanceDatagram(message);
    if (!update?.units.length) return;
    const session = this.sessions.get(`${update.mapId}:${update.instanceId}`);
    if (!session) return;
    for (const listener of session.listeners) listener.onAppearances?.(update);
  }

  private receiveCombatEvents(message: Buffer): void {
    const update = parseCombatEventDatagram(message);
    if (!update || (!update.events.length && !update.dropped)) return;
    const session = this.sessions.get(`${update.mapId}:${update.instanceId}`);
    if (!session) return;
    for (const listener of session.listeners) listener.onCombatEvents?.(update);
  }

  private receiveUnitAuras(message: Buffer): void {
    const update = parseUnitAuraDatagram(message);
    if (!update?.units.length) return;
    const session = this.sessions.get(`${update.mapId}:${update.instanceId}`);
    if (!session) return;
    for (const listener of session.listeners) listener.onUnitAuras?.(update);
  }

  private setStatus(session: WatchedSession, status: StreamStatus): void {
    if (session.status === status) return;
    session.status = status;
    for (const listener of session.listeners) listener.onStatus(status);
  }
}
