import type { MapPlayerPosition } from '../../../src/types/electron';
import { CLASS_NAMES, RACE_ICONS, RACE_NAMES, escapeHtml } from './helpers';

export type PlayerStateIconKey = 'spirit' | 'death' | 'resurrect' | 'flag' | 'sap' | 'stun' | 'taxi' | 'mounted' | 'combat';

interface PlayerIconManifest {
  version: 1;
  portraits: Record<string, string>;
  classes: Record<string, string>;
  states: Partial<Record<PlayerStateIconKey, string>>;
}

export interface PlayerStateIndicator {
  key: PlayerStateIconKey;
  label: string;
  fallback: string;
}

const CLASS_FALLBACKS: Record<number, string> = {
  1: '⚔️', 2: '🛡️', 3: '🏹', 4: '🗡️', 5: '✨', 6: '☠️', 7: '⚡', 8: '❄️', 9: '🔥', 11: '🐾',
};

const STATE_DEFINITIONS: Record<PlayerStateIconKey, PlayerStateIndicator> = {
  spirit: { key: 'spirit', label: 'Spirit of Redemption', fallback: '👻' },
  death: { key: 'death', label: 'Dead', fallback: '☠️' },
  resurrect: { key: 'resurrect', label: 'Waiting to resurrect', fallback: '⏳' },
  flag: { key: 'flag', label: 'Carrying battleground flag', fallback: '🚩' },
  sap: { key: 'sap', label: 'Sapped', fallback: '💤' },
  stun: { key: 'stun', label: 'Stunned', fallback: '💫' },
  taxi: { key: 'taxi', label: 'Taxi flight', fallback: '✈️' },
  mounted: { key: 'mounted', label: 'Mounted', fallback: '🐎' },
  combat: { key: 'combat', label: 'In combat', fallback: '⚔️' },
};

let manifest: PlayerIconManifest | null = null;
const imageCache = new Map<string, HTMLImageElement>();

export function getResponsivePlayerIconScale(baseScale: number, zoom = 1): number {
  const normalizedBase = Math.max(0.75, Math.min(2.5, baseScale));
  return normalizedBase * Math.max(1, Math.min(2, Math.sqrt(Math.max(1, zoom))));
}

function assetUrl(fileName: string): string {
  return `/assets/player-icons/${encodeURIComponent(fileName)}`;
}

export async function loadPlayerIconManifest(): Promise<boolean> {
  try {
    const response = await fetch('/assets/player-icons/index.json', { cache: 'no-cache' });
    if (!response.ok) return false;
    const candidate = await response.json() as PlayerIconManifest;
    if (candidate.version !== 1 || !candidate.portraits || !candidate.classes || !candidate.states) return false;
    manifest = candidate;
    return true;
  } catch {
    return false;
  }
}

function iconHtml(fileName: string | undefined, fallback: string, label: string, className: string): string {
  const title = escapeHtml(label);
  if (!fileName) return `<span class="${className} icon-fallback" title="${title}" aria-label="${title}">${fallback}</span>`;
  return `<img class="${className}" src="${assetUrl(fileName)}" alt="${title}" title="${title}">`;
}

export function getRacePortraitManifestKey(race: number, gender?: number): string {
  return `${race}:${gender === 1 ? 1 : 0}`;
}

export function getRacePortraitHtml(race: number, gender?: number, className = 'player-portrait-icon'): string {
  const normalizedGender = gender === 1 ? 1 : 0;
  const fallback = RACE_ICONS[race] ?? '🧑';
  const genderLabel = gender === 0 || gender === 1 ? (normalizedGender === 1 ? ' female' : ' male') : '';
  const label = `${RACE_NAMES[race] ?? `Race ${race}`}${genderLabel}`;
  return iconHtml(manifest?.portraits[getRacePortraitManifestKey(race, gender)], fallback, label, className);
}

export function getClassIconHtml(playerClass: number, className = 'player-class-icon'): string {
  return iconHtml(manifest?.classes[String(playerClass)], CLASS_FALLBACKS[playerClass] ?? '❔',
    CLASS_NAMES[playerClass] ?? `Class ${playerClass}`, className);
}

export function getPlayerStateIndicators(player: Pick<MapPlayerPosition,
  'alive' | 'inCombat' | 'onTaxi' | 'mounted' | 'sapped' | 'stunned' | 'spiritForm' | 'flagCarrier' | 'waitingForResurrect'>,
  limit = 3): PlayerStateIndicator[] {
  const keys: PlayerStateIconKey[] = [];
  if (player.spiritForm) return [STATE_DEFINITIONS.spirit].slice(0, Math.max(0, limit));
  if (!player.alive) {
    keys.push(player.waitingForResurrect ? 'resurrect' : 'death');
    return keys.slice(0, Math.max(0, limit)).map((key) => STATE_DEFINITIONS[key]);
  }
  if (player.flagCarrier) keys.push('flag');
  if (player.sapped) keys.push('sap');
  if (player.stunned) keys.push('stun');
  if (player.onTaxi) keys.push('taxi');
  else if (player.mounted) keys.push('mounted');
  if (player.inCombat) keys.push('combat');
  return keys.slice(0, Math.max(0, limit)).map((key) => STATE_DEFINITIONS[key]);
}

export function getPlayerStateIconsHtml(player: Parameters<typeof getPlayerStateIndicators>[0], limit = 3): string {
  const states = getPlayerStateIndicators(player, limit);
  if (!states.length) return '';
  return `<span class="player-state-icons">${states.map((state) =>
    iconHtml(manifest?.states[state.key], state.fallback, state.label, 'player-state-icon')).join('')}</span>`;
}

function cachedImage(fileName: string | undefined): HTMLImageElement | null {
  if (!fileName) return null;
  const url = assetUrl(fileName);
  let image = imageCache.get(url);
  if (!image) {
    image = new Image();
    image.src = url;
    imageCache.set(url, image);
  }
  return image.complete && image.naturalWidth > 0 ? image : null;
}

export function getClassIconImage(playerClass: number): HTMLImageElement | null {
  return cachedImage(manifest?.classes[String(playerClass)]);
}

export function getStateIconImage(key: PlayerStateIconKey): HTMLImageElement | null {
  return cachedImage(manifest?.states[key]);
}
