import type { SessionRecord, SessionRoutePoint, SessionTotals } from '../../../src/types/electron';

const MAX_ROUTE_JUMP_DISTANCE = 250;
const MAX_DEAD_ROUTE_JUMP_DISTANCE = 50;

export function formatSessionReplayTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function isSessionRouteDiscontinuity(
  previous: Pick<SessionRoutePoint, 'x' | 'y' | 'alive'>,
  current: Pick<SessionRoutePoint, 'x' | 'y' | 'alive'>,
): boolean {
  const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
  return previous.alive !== current.alive
    || distance > MAX_ROUTE_JUMP_DISTANCE
    || (!current.alive && distance > MAX_DEAD_ROUTE_JUMP_DISTANCE);
}

export function calculateSessionTotalsAt(record: SessionRecord, elapsedMs: number): SessionTotals {
  const totals: SessionTotals = { kills: 0, deaths: 0, lootItems: 0, levelUps: 0, objectives: 0, flagCaptures: 0 };
  for (const event of record.events) {
    if (event.elapsedMs > elapsedMs) break;
    if (event.type === 'kill') totals.kills += 1;
    else if (event.type === 'death') totals.deaths += 1;
    else if (event.type === 'loot') totals.lootItems += event.amount;
    else if (event.type === 'level') totals.levelUps += 1;
    else if (event.type === 'objective') totals.objectives += 1;
    else if (event.type === 'flag-capture') totals.flagCaptures += 1;
  }
  return totals;
}
