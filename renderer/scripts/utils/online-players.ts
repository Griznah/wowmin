import type { PlayerInfo } from '../types/state';
import type { OnlinePlayerRow } from '../../../src/types/electron';
import { getMapName, getZoneName, RACE_NAMES, CLASS_NAMES } from './helpers';

function toPlayer(row: OnlinePlayerRow): PlayerInfo {
  const mapId = Number(row.mapId);
  const zoneId = Number(row.zoneId);
  const raceId = Number(row.raceId);
  const classId = Number(row.classId);
  const account = String(row.account).trim();
  return {
    account,
    name: String(row.name).trim(),
    ip: String(row.ip || ''),
    mapId,
    zoneId,
    expansion: Number(row.expansion),
    gmLevel: Number(row.gmLevel),
    isBot: /^RNDBOT/i.test(account),
    mapName: getMapName(mapId),
    zoneName: getZoneName(zoneId),
    level: String(row.level),
    race: RACE_NAMES[raceId] || '',
    className: CLASS_NAMES[classId] || '',
    raceId,
    classId,
    gender: row.gender === undefined ? undefined : Number(row.gender),
  };
}

export function playersFromDatabase(rows: OnlinePlayerRow[]): PlayerInfo[] {
  return rows.map(toPlayer).filter((player) => player.name && Number.isFinite(player.mapId));
}

export function parseOnlineList(message: string): PlayerInfo[] {
  const rows: OnlinePlayerRow[] = [];
  for (const line of message.split(/[\r\n]+/)) {
    const match = line.trim().match(/^-\[([^\]]+)\]\[([^\]]+)\]\[([^\]]+)\]\[([^\]]+)\]\[([^\]]+)\]\[([^\]]+)\]\[([^\]]+)\]-$/);
    if (!match) continue;
    const [account, name, ip] = match.slice(1, 4).map((part) => part.trim());
    const [mapId, zoneId, expansion, gmLevel] = match.slice(4).map((part) => Number(part.trim()));
    if (!name || !account || ![mapId, zoneId, expansion, gmLevel].every(Number.isInteger)) continue;
    rows.push({ account, name, ip, mapId, zoneId, expansion, gmLevel, level: 0, raceId: 0, classId: 0 });
  }
  return playersFromDatabase(rows).map((player) => ({ ...player, level: '' }));
}
