import type { SessionBattlegroundOutcome } from './types/electron';

const PVP_TEAM_ALLIANCE = 0;
const PVP_TEAM_HORDE = 1;
const PVP_TEAM_NEUTRAL = 2;

// These are the battlegrounds whose team score is meaningful as a compact
// final scoreline. WSG counts flag captures; EotS counts resource points
// (including resources awarded for flag captures).
const SCORELINE_MAPS = new Set([489, 566]);

export function formatBattlegroundOutcome(outcome?: SessionBattlegroundOutcome): string | null {
  if (!outcome || outcome.status !== 4) return null;

  let result: string;
  if (outcome.winner === PVP_TEAM_ALLIANCE) result = 'Alliance wins';
  else if (outcome.winner === PVP_TEAM_HORDE) result = 'Horde wins';
  else if (outcome.winner === PVP_TEAM_NEUTRAL) result = 'Draw';
  else return null;

  if (!SCORELINE_MAPS.has(outcome.mapId)) return result;
  if (outcome.winner === PVP_TEAM_ALLIANCE) {
    return `${result} ${outcome.allianceScore}-${outcome.hordeScore}`;
  }
  if (outcome.winner === PVP_TEAM_HORDE) {
    return `${result} ${outcome.hordeScore}-${outcome.allianceScore}`;
  }
  return `${result} ${outcome.allianceScore}-${outcome.hordeScore}`;
}
