// Nameplates over units in the 3D view, drawn on the 2D overlay in the look
// of three themes from the TidyPlates addon: Neon (a slim glowing bar, the
// name above), Grey (a flat bar with the name inside), and Quatre (a square,
// chunky bar with level and health text on it). Drawn from scratch to match
// their look; none of the addon's art is used. Plates keep one size on
// screen whatever the zoom, as the client's do.

export type PlateStyle = 'neon' | 'grey' | 'quatre';
export type Faction = 'alliance' | 'horde';

export interface Nameplate {
  name: string;
  // '80', or '' for none; bosses show a skull instead.
  level: string;
  levelColor: string;
  elite: boolean;
  boss: boolean;
  healthPct: number;
  barColor: string;
  alive: boolean;
  // A mob attacking a player, or a player a mob is attacking.
  threat: boolean;
  selected: boolean;
  // A cast fills up; a channel drains. Its spell's icon sits at the cast
  // bar's left, as TidyPlates shows it.
  cast: { fraction: number; name: string; channeled: boolean; icon?: CanvasImageSource | null } | null;
  // A line under the plate: a bot's current action.
  note: string | null;
  // In battlegrounds, the player's side: a crest by the name, which takes
  // the side's colour. The client's crest when it has loaded.
  faction?: Faction | null;
  factionIcon?: CanvasImageSource | null;
}

interface Theme {
  width: number;
  barHeight: number;
  castHeight: number;
  // Space between the name and the bar, and between the bar and the cast.
  gap: number;
  nameFont: string;
  nameInside: boolean;
  healthText: boolean;
  border: number;
}

const THEMES: Record<PlateStyle, Theme> = {
  neon: { width: 92, barHeight: 7, castHeight: 5, gap: 2, nameFont: '700 11px system-ui, sans-serif', nameInside: false, healthText: false, border: 1 },
  grey: { width: 104, barHeight: 12, castHeight: 9, gap: 2, nameFont: '700 9px system-ui, sans-serif', nameInside: true, healthText: true, border: 1 },
  quatre: { width: 112, barHeight: 14, castHeight: 8, gap: 2, nameFont: '700 10px system-ui, sans-serif', nameInside: false, healthText: true, border: 2 },
};

const THREAT_COLOR = '#ff2a1a';
const SELECTED_COLOR = '#ffffff';
const CAST_COLOR = '#f2b134';
const CHANNEL_COLOR = '#58c85a';
const NOTE_FONT = 'italic 10px sans-serif';
const NOTE_COLOR = '#fcd34d';
const DEAD_COLOR = '#94a3b8';
// Names in the side's colour, light enough to read on the dark outline.
export const FACTION_NAME_COLORS: Record<Faction, string> = { alliance: '#6cb4ff', horde: '#ff6a5a' };
const CREST_SIZE = 12;

// The level's colour by how it compares with the party's, as the client
// colours it: grey far below, green below, yellow close, orange and red above.
export function levelColor(level: number, partyLevel: number): string {
  const difference = level - partyLevel;
  if (difference >= 5) return '#ff2020';
  if (difference >= 3) return '#ff8040';
  if (difference >= -2) return '#ffff00';
  if (level > greyLevel(partyLevel)) return '#40c040';
  return '#808080';
}

// The highest level that gives a level `partyLevel` character no experience
// (Wrath's rule).
function greyLevel(partyLevel: number): number {
  if (partyLevel <= 5) return 0;
  if (partyLevel <= 39) return partyLevel - Math.floor(partyLevel / 10) - 5;
  if (partyLevel <= 59) return partyLevel - Math.floor(partyLevel / 5) - 1;
  return partyLevel - 9;
}

// The plate's box around its anchor (the point over the unit's head, which is
// the bottom middle of the plate), for keeping plates apart.
export function plateBounds(style: PlateStyle, plate: Nameplate, scale: number): { left: number; right: number; top: number; bottom: number } {
  const theme = THEMES[style];
  const half = (theme.width / 2 + 20) * scale;
  return { left: -half, right: half, top: -plateHeight(theme, plate) * scale, bottom: 0 };
}

function plateHeight(theme: Theme, plate: Nameplate): number {
  if (!plate.alive) return 12;
  const name = theme.nameInside ? 0 : 12 + theme.gap;
  const cast = plate.cast ? theme.gap + theme.castHeight + (theme.castHeight < 8 ? 11 : 0) : 0;
  const note = plate.note ? 13 : 0;
  return name + theme.barHeight + cast + note + 2;
}

// Draws the plate with its bottom middle at (x, y).
export function drawNameplate(ctx: CanvasRenderingContext2D, style: PlateStyle, plate: Nameplate, x: number, y: number, scale: number): void {
  const theme = THEMES[style];
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.scale(scale, scale);
  ctx.translate(0, -plateHeight(theme, plate));
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const faction = plate.faction ?? null;
  if (!plate.alive) {
    ctx.font = theme.nameFont;
    ctx.textAlign = 'center';
    outlinedText(ctx, plate.name, 0, 6, DEAD_COLOR);
    if (faction) drawFactionCrest(ctx, faction, -ctx.measureText(plate.name).width / 2 - CREST_SIZE * 0.75, 6, CREST_SIZE, plate.factionIcon);
    ctx.restore();
    return;
  }
  const left = -theme.width / 2;
  const nameColor = faction ? FACTION_NAME_COLORS[faction] : '#ffffff';
  let top = 0;
  if (!theme.nameInside) {
    ctx.font = theme.nameFont;
    if (style === 'quatre') {
      ctx.textAlign = 'left';
      const nameLeft = faction ? left + CREST_SIZE + 3 : left;
      if (faction) drawFactionCrest(ctx, faction, left + CREST_SIZE / 2, 6, CREST_SIZE, plate.factionIcon);
      outlinedText(ctx, plate.name.toUpperCase(), nameLeft, 6, nameColor);
    } else {
      ctx.textAlign = 'center';
      outlinedText(ctx, plate.name, 0, 6, nameColor);
      if (faction) drawFactionCrest(ctx, faction, -ctx.measureText(plate.name).width / 2 - CREST_SIZE * 0.75, 6, CREST_SIZE, plate.factionIcon);
    }
    top += 12 + theme.gap;
  } else if (faction) {
    // The name is inside the bar: the crest sits just left of it.
    drawFactionCrest(ctx, faction, left - CREST_SIZE * 0.75, top + theme.barHeight / 2, CREST_SIZE, plate.factionIcon);
  }
  if (style === 'neon') drawNeonBar(ctx, theme, plate, left, top);
  else if (style === 'grey') drawGreyBar(ctx, theme, plate, left, top);
  else drawQuatreBar(ctx, theme, plate, left, top);
  top += theme.barHeight;
  if (plate.cast) {
    top += theme.gap;
    drawCastBar(ctx, style, theme, plate.cast, left, top);
    top += theme.castHeight + (theme.castHeight < 8 ? 11 : 0);
  }
  if (plate.note) {
    ctx.font = NOTE_FONT;
    ctx.textAlign = 'center';
    outlinedText(ctx, plate.note, 0, top + 7, NOTE_COLOR);
  }
  ctx.restore();
}

function drawNeonBar(ctx: CanvasRenderingContext2D, theme: Theme, plate: Nameplate, left: number, top: number): void {
  const { width, barHeight: height } = theme;
  // The glow: red for threat, white for the selected unit, else the bar's own.
  ctx.save();
  ctx.shadowColor = plate.threat ? THREAT_COLOR : plate.selected ? SELECTED_COLOR : withAlpha(plate.barColor, 0.55);
  ctx.shadowBlur = plate.threat || plate.selected ? 9 : 5;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(left - 1, top - 1, width + 2, height + 2);
  ctx.restore();
  const fill = width * fraction(plate.healthPct);
  const gloss = ctx.createLinearGradient(0, top, 0, top + height);
  gloss.addColorStop(0, lighten(plate.barColor, 0.45));
  gloss.addColorStop(0.5, plate.barColor);
  gloss.addColorStop(1, darken(plate.barColor, 0.35));
  ctx.fillStyle = gloss;
  ctx.fillRect(left, top, fill, height);
  ctx.strokeStyle = plate.threat ? THREAT_COLOR : plate.selected ? SELECTED_COLOR : 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(left - 0.5, top - 0.5, width + 1, height + 1);
  drawLevel(ctx, plate, left + width + 4, top + height / 2, '700 9px system-ui, sans-serif', 'left');
}

function drawGreyBar(ctx: CanvasRenderingContext2D, theme: Theme, plate: Nameplate, left: number, top: number): void {
  const { width, barHeight: height } = theme;
  ctx.fillStyle = 'rgba(38,38,38,0.85)';
  ctx.fillRect(left, top, width, height);
  ctx.fillStyle = desaturate(plate.barColor, 0.25);
  ctx.fillRect(left, top, width * fraction(plate.healthPct), height);
  ctx.strokeStyle = plate.threat ? THREAT_COLOR : plate.selected ? SELECTED_COLOR : '#000000';
  ctx.lineWidth = plate.threat || plate.selected ? 2 : 1;
  ctx.strokeRect(left - 0.5, top - 0.5, width + 1, height + 1);
  ctx.font = theme.nameFont;
  ctx.textAlign = 'left';
  outlinedText(ctx, clip(ctx, plate.name, width - 34), left + 3, top + height / 2 + 0.5,
    plate.faction ? FACTION_NAME_COLORS[plate.faction] : '#ffffff');
  ctx.textAlign = 'right';
  outlinedText(ctx, `${Math.round(plate.healthPct)}%`, left + width - 3, top + height / 2 + 0.5, '#e5e5e5');
  drawLevel(ctx, plate, left + width + 4, top + height / 2, '700 9px system-ui, sans-serif', 'left');
}

function drawQuatreBar(ctx: CanvasRenderingContext2D, theme: Theme, plate: Nameplate, left: number, top: number): void {
  const { width, barHeight: height, border } = theme;
  const levelWidth = 18;
  ctx.fillStyle = plate.threat ? THREAT_COLOR : plate.selected ? '#f5d142' : '#000000';
  ctx.fillRect(left - border, top - border, width + border * 2, height + border * 2);
  // The level in its own square at the left.
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(left, top, levelWidth, height);
  const barLeft = left + levelWidth + 1;
  const barWidth = width - levelWidth - 1;
  ctx.fillStyle = '#2b2b2b';
  ctx.fillRect(barLeft, top, barWidth, height);
  ctx.fillStyle = plate.barColor;
  ctx.fillRect(barLeft, top, barWidth * fraction(plate.healthPct), height);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(barLeft, top, barWidth * fraction(plate.healthPct), height / 2);
  drawLevel(ctx, plate, left + levelWidth / 2, top + height / 2 + 0.5, '700 10px system-ui, sans-serif', 'center');
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  outlinedText(ctx, `${Math.round(plate.healthPct)}%`, left + width - 3, top + height / 2 + 0.5, '#ffffff');
}

function drawCastBar(ctx: CanvasRenderingContext2D, style: PlateStyle, theme: Theme, cast: NonNullable<Nameplate['cast']>, left: number, top: number): void {
  const width = theme.width;
  const height = theme.castHeight;
  const filled = cast.channeled ? 1 - fraction(cast.fraction * 100) : fraction(cast.fraction * 100);
  const color = cast.channeled ? CHANNEL_COLOR : CAST_COLOR;
  ctx.fillStyle = style === 'neon' ? 'rgba(0,0,0,0.65)' : 'rgba(20,20,20,0.85)';
  ctx.fillRect(left, top, width, height);
  ctx.fillStyle = color;
  ctx.fillRect(left, top, width * filled, height);
  ctx.strokeStyle = style === 'neon' ? 'rgba(255,255,255,0.35)' : '#000000';
  ctx.lineWidth = style === 'quatre' ? 2 : 1;
  ctx.strokeRect(left - 0.5, top - 0.5, width + 1, height + 1);
  if (cast.icon) {
    // A square as tall as the cast bar and its name, left of the bar.
    const size = height < 8 ? height + 11 : height + 4;
    const iconTop = height < 8 ? top - 1 : top - 2;
    ctx.drawImage(cast.icon, left - size - 3, iconTop, size, size);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.strokeRect(left - size - 3.5, iconTop - 0.5, size + 1, size + 1);
  }
  if (!cast.name) return;
  // Thin cast bars put the spell's name under them; thick ones inside.
  if (height < 8) {
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    outlinedText(ctx, cast.name, 0, top + height + 6, '#ffffff');
  } else {
    ctx.font = '600 8px system-ui, sans-serif';
    ctx.textAlign = style === 'quatre' ? 'left' : 'center';
    outlinedText(ctx, clip(ctx, cast.name, width - 6), style === 'quatre' ? left + 3 : 0, top + height / 2 + 0.5, '#ffffff');
  }
}

function drawLevel(ctx: CanvasRenderingContext2D, plate: Nameplate, x: number, y: number, font: string, align: CanvasTextAlign): void {
  if (plate.boss) {
    drawSkull(ctx, align === 'left' ? x + 4 : x, y, 8);
    return;
  }
  if (!plate.level) return;
  ctx.font = font;
  ctx.textAlign = align;
  outlinedText(ctx, plate.elite ? `${plate.level}+` : plate.level, x, y + 0.5, plate.levelColor);
}

// A side's crest, centred on (x, y), `size` tall: the client's PvP crest
// (`icon`) when it has loaded, else a stand-in drawn in the side's colours
// (the Alliance's blue heater shield with a gold rim, the Horde's red shield
// with three spikes along its top).
export function drawFactionCrest(ctx: CanvasRenderingContext2D, faction: Faction, x: number, y: number, size: number,
  icon?: CanvasImageSource | null): void {
  if (icon) {
    const width = 'width' in icon && 'height' in icon && Number(icon.height) > 0
      ? size * Number(icon.width) / Number(icon.height) : size;
    ctx.drawImage(icon, x - width / 2, y - size / 2, width, size);
    return;
  }
  const half = size / 2;
  const width = size * 0.8;
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  if (faction === 'alliance') {
    ctx.moveTo(-width / 2, -half);
    ctx.lineTo(width / 2, -half);
    ctx.lineTo(width / 2, -half * 0.1);
    ctx.quadraticCurveTo(width / 2, half * 0.6, 0, half);
    ctx.quadraticCurveTo(-width / 2, half * 0.6, -width / 2, -half * 0.1);
    ctx.closePath();
    ctx.fillStyle = '#1f4fbf';
    ctx.strokeStyle = '#e8c547';
  } else {
    ctx.moveTo(-width / 2, -half);
    ctx.lineTo(-width / 4, -half * 0.45);
    ctx.lineTo(0, -half * 1.05);
    ctx.lineTo(width / 4, -half * 0.45);
    ctx.lineTo(width / 2, -half);
    ctx.lineTo(width / 2, -half * 0.05);
    ctx.quadraticCurveTo(width / 2, half * 0.55, 0, half);
    ctx.quadraticCurveTo(-width / 2, half * 0.55, -width / 2, -half * 0.05);
    ctx.closePath();
    ctx.fillStyle = '#b3201a';
    ctx.strokeStyle = '#1c0605';
  }
  ctx.lineWidth = Math.max(1, size / 8);
  ctx.lineJoin = 'round';
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawSkull(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.save();
  ctx.fillStyle = '#f8fafc';
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y - size * 0.12, size * 0.45, 0, Math.PI * 2);
  ctx.rect(x - size * 0.25, y + size * 0.15, size * 0.5, size * 0.3);
  ctx.stroke();
  ctx.fill();
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.arc(x - size * 0.17, y - size * 0.12, size * 0.11, 0, Math.PI * 2);
  ctx.arc(x + size * 0.17, y - size * 0.12, size * 0.11, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function outlinedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// The text cut to fit `width`, ending in an ellipsis when cut.
function clip(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let end = text.length;
  while (end > 1 && ctx.measureText(`${text.slice(0, end)}…`).width > width) end -= 1;
  return `${text.slice(0, end)}…`;
}

const fraction = (percent: number): number => Math.max(0, Math.min(1, percent / 100));

function parseHex(color: string): [number, number, number] {
  const hex = color.replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((digit) => digit + digit).join('') : hex.slice(0, 6);
  const value = Number.parseInt(full, 16);
  return Number.isFinite(value) ? [(value >> 16) & 255, (value >> 8) & 255, value & 255] : [128, 128, 128];
}

const rgb = ([r, g, b]: [number, number, number]): string => `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;

function lighten(color: string, amount: number): string {
  return rgb(parseHex(color).map((channel) => channel + (255 - channel) * amount) as [number, number, number]);
}

function darken(color: string, amount: number): string {
  return rgb(parseHex(color).map((channel) => channel * (1 - amount)) as [number, number, number]);
}

function desaturate(color: string, amount: number): string {
  const channels = parseHex(color);
  const grey = (channels[0] + channels[1] + channels[2]) / 3;
  return rgb(channels.map((channel) => channel + (grey - channel) * amount) as [number, number, number]);
}

function withAlpha(color: string, alpha: number): string {
  const [r, g, b] = parseHex(color);
  return `rgba(${r},${g},${b},${alpha})`;
}
