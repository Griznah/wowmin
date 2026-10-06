import type { MapBattlegroundState, MapPlayerPosition } from '../../../src/types/electron';
import { getMapName } from './helpers';

export interface ActiveInstanceSession {
  key: string;
  mapId: number;
  instanceId: number;
  label: string;
  players: MapPlayerPosition[];
}

export interface InstanceCoordinateBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface InstanceMapProfile {
  mapId: number;
  bounds: InstanceCoordinateBounds;
  aspectRatio: number;
  source: string;
}

export interface InstanceProjectionViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InstanceViewTransform {
  zoom: number;
  panX: number;
  panY: number;
}

export interface DungeonMapFloor {
  id: number;
  floorIndex: number;
  image: string;
  width: number;
  height: number;
  bounds: InstanceCoordinateBounds;
  chunks: Array<{ wmoGroupId: number; minZ: number }>;
}

export interface MinimapTileProjection {
  minTileX: number;
  minTileY: number;
  maxTileX: number;
  maxTileY: number;
  gridSize: number;
  worldUnitsPerTile: number;
}

// WorldMapArea.dbc row 443. The client map transform swaps world X/Y;
// therefore the rendered width is the world-Y span and height is world-X.
const INSTANCE_MAP_PROFILES = new Map<number, InstanceMapProfile>([
  [489, {
    mapId: 489,
    bounds: { minX: 862.4999389648438, maxX: 1627.083251953125, minY: 895.8333129882812, maxY: 2041.6666259765625 },
    aspectRatio: (2041.6666259765625 - 895.8333129882812) / (1627.083251953125 - 862.4999389648438),
    source: 'WorldMapArea.dbc:443',
  }],
]);

export function getBattlegroundStatusLabel(status: number): string {
  return ['Inactive', 'Queued', 'Preparing', 'In progress', 'Complete'][status] ?? `Status ${status}`;
}

export function getBattlegroundStrategyLabel(battlegroundTypeId: number, strategy: number): string | null {
  if (strategy < 0) return null;
  if (battlegroundTypeId === 7) {
    return ['Balanced', 'Front focus', 'Back focus', 'Flag focus'][strategy] ?? `Strategy ${strategy}`;
  }
  if ([1, 2, 3].includes(battlegroundTypeId)) {
    return ['Balanced', 'Offensive', 'Defensive'][strategy] ?? `Strategy ${strategy}`;
  }
  return null;
}

export function getBattlegroundObjectiveLabels(battleground: MapBattlegroundState): string[] {
  const states = new Map(battleground.worldStates.map((state) => [state.id, state.value]));
  const value = (id: number): number | undefined => states.get(id);
  const labels: string[] = [];

  switch (battleground.mapId) {
    case 489: {
      const flagState = (state?: number): string => ['Unknown', 'At base', 'Carried', 'Dropped'][state ?? 0] ?? `State ${state}`;
      labels.push(`Alliance flag: ${flagState(value(2339))}`);
      labels.push(`Horde flag: ${flagState(value(2338))}`);
      break;
    }
    case 529:
      labels.push(`Alliance bases: ${value(1779) ?? 0}`);
      labels.push(`Horde bases: ${value(1778) ?? 0}`);
      break;
    case 566:
      labels.push(`Alliance bases: ${value(2752) ?? 0}`);
      labels.push(`Horde bases: ${value(2753) ?? 0}`);
      if ((value(2769) ?? 0) === 2) labels.push('Flag carried by Alliance');
      else if ((value(2770) ?? 0) === 2) labels.push('Flag carried by Horde');
      else labels.push('Flag available');
      break;
    case 30:
      labels.push(`Alliance reinforcements: ${value(3127) ?? battleground.allianceScore}`);
      labels.push(`Horde reinforcements: ${value(3128) ?? battleground.hordeScore}`);
      break;
    case 628: {
      labels.push(`Alliance reinforcements: ${value(4226) ?? 0}`);
      labels.push(`Horde reinforcements: ${value(4227) ?? 0}`);
      const controlledStates: Array<[number, string]> = [
        [4229, 'Workshop · Alliance'], [4230, 'Workshop · Horde'],
        [4298, 'Hangar · Horde'], [4299, 'Hangar · Alliance'],
        [4303, 'Docks · Horde'], [4304, 'Docks · Alliance'],
        [4308, 'Quarry · Horde'], [4309, 'Quarry · Alliance'],
        [4313, 'Refinery · Horde'], [4314, 'Refinery · Alliance'],
      ];
      for (const [id, label] of controlledStates) if (value(id)) labels.push(label);
      const breachedGates: Array<[number, string]> = [
        [4320, 'Horde east gate breached'], [4321, 'Horde west gate breached'],
        [4322, 'Horde front gate breached'], [4323, 'Alliance front gate breached'],
        [4324, 'Alliance west gate breached'], [4325, 'Alliance east gate breached'],
      ];
      for (const [id, label] of breachedGates) if (value(id)) labels.push(label);
      break;
    }
    case 607: {
      const gateStates: Array<[number, string]> = [
        [3614, 'Purple gate'], [3617, 'Red gate'], [3620, 'Blue gate'], [3623, 'Green gate'],
        [3638, 'Yellow gate'], [3849, 'Ancient gate'],
      ];
      const gateStatus = (state: number): string => ['Unknown', 'Intact', 'Damaged', 'Destroyed'][state]
        ?? `State ${state}`;
      for (const [id, label] of gateStates) {
        const state = value(id);
        if (state !== undefined) labels.push(`${label}: ${gateStatus(state)}`);
      }
      break;
    }
    default:
      break;
  }

  return labels;
}

export function getInstanceMapProfile(mapId: number): InstanceMapProfile | null {
  return INSTANCE_MAP_PROFILES.get(mapId) ?? null;
}

export function applyInstanceViewTransform(
  viewport: InstanceProjectionViewport,
  transform: InstanceViewTransform,
): InstanceProjectionViewport {
  const width = viewport.width * transform.zoom;
  const height = viewport.height * transform.zoom;
  return {
    x: viewport.x + (viewport.width - width) / 2 + transform.panX,
    y: viewport.y + (viewport.height - height) / 2 + transform.panY,
    width,
    height,
  };
}

export function zoomInstanceViewAt(
  transform: InstanceViewTransform,
  viewport: InstanceProjectionViewport,
  anchorX: number,
  anchorY: number,
  zoom: number,
): InstanceViewTransform {
  const nextZoom = Math.min(6, Math.max(1, zoom));
  if (nextZoom === 1) return { zoom: 1, panX: 0, panY: 0 };

  const current = applyInstanceViewTransform(viewport, transform);
  const relativeX = current.width ? (anchorX - current.x) / current.width : 0.5;
  const relativeY = current.height ? (anchorY - current.y) / current.height : 0.5;
  const nextWidth = viewport.width * nextZoom;
  const nextHeight = viewport.height * nextZoom;
  return {
    zoom: nextZoom,
    panX: anchorX - viewport.x - (viewport.width - nextWidth) / 2 - relativeX * nextWidth,
    panY: anchorY - viewport.y - (viewport.height - nextHeight) / 2 - relativeY * nextHeight,
  };
}

export function getInstanceProjectionViewport(
  width: number,
  height: number,
  aspectRatio: number,
): InstanceProjectionViewport {
  if (width / height > aspectRatio) {
    const viewportWidth = height * aspectRatio;
    return { x: (width - viewportWidth) / 2, y: 0, width: viewportWidth, height };
  }
  const viewportHeight = width / aspectRatio;
  return { x: 0, y: (height - viewportHeight) / 2, width, height: viewportHeight };
}

export function parseInstanceSessionKey(key: string | null): { mapId: number; instanceId: number } | null {
  if (!key) return null;
  const match = key.match(/^(\d+):(\d+)$/);
  if (!match) return null;
  const mapId = Number(match[1]);
  const instanceId = Number(match[2]);
  if (!Number.isInteger(mapId) || mapId < 0 || !Number.isInteger(instanceId) || instanceId <= 0) return null;
  return { mapId, instanceId };
}

export function groupActiveInstanceSessions(players: MapPlayerPosition[]): ActiveInstanceSession[] {
  const grouped = new Map<string, ActiveInstanceSession>();
  for (const player of players) {
    if (!Number.isInteger(player.instanceId) || player.instanceId <= 0) continue;
    const key = `${player.map}:${player.instanceId}`;
    let session = grouped.get(key);
    if (!session) {
      session = {
        key,
        mapId: player.map,
        instanceId: player.instanceId,
        label: `${getMapName(player.map)} · #${player.instanceId}`,
        players: [],
      };
      grouped.set(key, session);
    }
    session.players.push(player);
  }

  return [...grouped.values()].sort((left, right) =>
    right.players.length - left.players.length || left.label.localeCompare(right.label));
}

export function getInstanceCoordinateBounds(players: MapPlayerPosition[]): InstanceCoordinateBounds {
  if (!players.length) return { minX: -100, maxX: 100, minY: -100, maxY: 100 };
  const xValues = players.map((player) => player.position_x);
  const yValues = players.map((player) => player.position_y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const spanX = Math.max(200, maxX - minX);
  const spanY = Math.max(200, maxY - minY);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    minX: centerX - spanX * 0.65,
    maxX: centerX + spanX * 0.65,
    minY: centerY - spanY * 0.65,
    maxY: centerY + spanY * 0.65,
  };
}

export function getParticipantDungeonFloor(
  player: Pick<MapPlayerPosition, 'position_x' | 'position_y' | 'position_z' | 'wmoGroupId'>,
  floors: DungeonMapFloor[],
): DungeonMapFloor | null {
  if (player.wmoGroupId !== undefined && player.wmoGroupId >= 0) {
    const matchingChunks = floors.flatMap((floor) => floor.chunks
      .filter((chunk) => chunk.wmoGroupId === player.wmoGroupId)
      .map((chunk) => ({ floor, minZ: chunk.minZ })));
    if (matchingChunks.length > 0) {
      const belowPlayer = matchingChunks
        .filter((candidate) => candidate.minZ <= player.position_z)
        .sort((left, right) => right.minZ - left.minZ);
      return (belowPlayer[0] ?? matchingChunks.sort((left, right) => left.minZ - right.minZ)[0]).floor;
    }
  }

  return floors.find((floor) =>
    player.position_x >= floor.bounds.minX
    && player.position_x <= floor.bounds.maxX
    && player.position_y >= floor.bounds.minY
    && player.position_y <= floor.bounds.maxY) ?? null;
}

export function projectMinimapTilePosition(
  position: Pick<MapPlayerPosition, 'position_x' | 'position_y'>,
  projection: MinimapTileProjection,
  width: number,
  height: number,
): { x: number; y: number } {
  const tileColumns = projection.maxTileX - projection.minTileX + 1;
  const tileRows = projection.maxTileY - projection.minTileY + 1;
  const fullTileX = projection.gridSize / 2 - position.position_y / projection.worldUnitsPerTile;
  const fullTileY = projection.gridSize / 2 - position.position_x / projection.worldUnitsPerTile;
  return {
    x: (fullTileX - projection.minTileX) / tileColumns * width,
    y: (fullTileY - projection.minTileY) / tileRows * height,
  };
}

export function projectInstancePosition(
  position: Pick<MapPlayerPosition, 'position_x' | 'position_y'>,
  bounds: InstanceCoordinateBounds,
  width: number,
  height: number,
): { x: number; y: number } {
  const x = ((bounds.maxY - position.position_y) / (bounds.maxY - bounds.minY)) * width;
  const y = ((bounds.maxX - position.position_x) / (bounds.maxX - bounds.minX)) * height;
  return { x, y };
}
