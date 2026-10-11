// Pure maths for playing the client's spell effect models: animation tracks
// exported by scripts/scene/effect-model.mjs, particle spawning, and the
// curves a particle follows over its life. Shapes follow wowdev.wiki's M2
// page where it is specific, and the common reading of it where it isn't.

// An exported track: g is the loop (global sequence) index or -1, s is true
// for stepped keys, and k maps a clip name (or 'global') to [times in ms,
// flat values].
export interface ExportedTrack {
  g: number;
  s: boolean;
  k: Record<string, [number[], number[]]>;
}

// Over a particle's life: times as fractions of it, flat values.
export interface LifeCurve {
  t: number[];
  v: number[];
}

export interface TrackClock {
  clip: string;
  // Time into the clip, in ms.
  timeMs: number;
  // Time since the effect started, in ms, for looping (global) tracks.
  elapsedMs: number;
  loops: readonly number[];
}

export type Vec3 = [number, number, number];

// The track's value at the clock's time, `width` numbers per key; the
// fallback when the track is missing or has no keys for this clip.
export function evalTrack(track: ExportedTrack | null | undefined, width: number, clock: TrackClock, fallback: number[]): number[] {
  if (!track) return fallback;
  let keys: [number[], number[]] | undefined;
  let time: number;
  if (track.g >= 0) {
    keys = track.k.global;
    const loop = clock.loops[track.g] ?? 0;
    time = loop > 0 ? clock.elapsedMs % loop : 0;
  } else {
    keys = track.k[clock.clip] ?? track.k.Stand;
    time = clock.timeMs;
  }
  if (!keys) return fallback;
  return interpolate(keys[0], keys[1], width, time, track.s);
}

export function interpolate(times: number[], values: number[], width: number, time: number, step = false): number[] {
  const count = Math.min(times.length, Math.floor(values.length / width));
  if (!count) return [];
  const at = (index: number) => values.slice(index * width, index * width + width);
  if (count === 1 || time <= times[0]) return at(0);
  if (time >= times[count - 1]) return at(count - 1);
  let index = 0;
  while (index < count - 2 && times[index + 1] <= time) index += 1;
  if (step) return at(index);
  const span = times[index + 1] - times[index];
  const t = span > 0 ? (time - times[index]) / span : 0;
  const from = at(index);
  const to = at(index + 1);
  return from.map((value, component) => value + (to[component] - value) * t);
}

// A curve over a particle's life at `fraction` (0 born, 1 dying).
export function evalLifeCurve(curve: LifeCurve, width: number, fraction: number, fallback: number[]): number[] {
  const values = interpolate(curve.t, curve.v, width, Math.min(1, Math.max(0, fraction)));
  return values.length ? values : fallback;
}

// UV rectangle [u0, v0, u1, v1] of cell `cell` on a texture of rows x
// columns cells, counted along each row first.
export function cellUv(cell: number, rows: number, columns: number): [number, number, number, number] {
  const safeRows = Math.max(1, rows);
  const safeColumns = Math.max(1, columns);
  const index = ((Math.floor(cell) % (safeRows * safeColumns)) + safeRows * safeColumns) % (safeRows * safeColumns);
  const column = index % safeColumns;
  const row = Math.floor(index / safeColumns);
  return [column / safeColumns, row / safeRows, (column + 1) / safeColumns, (row + 1) / safeRows];
}

// A random number in [-1, 1).
export type Random = () => number;
export const signedRandom = (): number => Math.random() * 2 - 1;

export interface SpawnParams {
  emitterType: number;
  // Plane: extent along x (length) and y (width). Sphere: minimum (length)
  // and maximum (width) radius.
  areaLength: number;
  areaWidth: number;
  verticalRange: number;
  horizontalRange: number;
  speed: number;
  speedVariation: number;
  zSource: number;
  splinePoints?: number[];
}

// Where a new particle starts and how fast it goes, relative to its
// emitter (Z up). `random` returns numbers in [-1, 1).
export function spawnParticle(params: SpawnParams, random: Random = signedRandom): { position: Vec3; velocity: Vec3 } {
  const speed = params.speed * (1 + random() * params.speedVariation);
  // Polar angle from straight up, and azimuth round it.
  const polar = random() * params.verticalRange;
  const azimuth = random() * params.horizontalRange;
  const direction: Vec3 = [Math.sin(polar) * Math.cos(azimuth), Math.sin(polar) * Math.sin(azimuth), Math.cos(polar)];
  let position: Vec3;
  let velocity: Vec3;
  if (params.emitterType === 2) {
    // Sphere: a shell between the two radii, flying outward.
    const radius = params.areaLength + ((random() + 1) / 2) * (params.areaWidth - params.areaLength);
    position = [direction[0] * radius, direction[1] * radius, direction[2] * radius];
    velocity = [direction[0] * speed, direction[1] * speed, direction[2] * speed];
  } else if (params.emitterType === 3 && params.splinePoints && params.splinePoints.length >= 6) {
    // Spline: a random point along the polyline through its points.
    const points = params.splinePoints.length / 3;
    const along = ((random() + 1) / 2) * (points - 1);
    const index = Math.min(points - 2, Math.floor(along));
    const t = along - index;
    const p = (i: number, axis: number) => params.splinePoints![i * 3 + axis];
    position = [0, 1, 2].map((axis) => p(index, axis) + (p(index + 1, axis) - p(index, axis)) * t) as Vec3;
    velocity = [direction[0] * speed, direction[1] * speed, direction[2] * speed];
  } else {
    // Plane: a point on the rectangle, flying up within the angles.
    position = [random() * params.areaLength * 0.5, random() * params.areaWidth * 0.5, 0];
    velocity = [direction[0] * speed, direction[1] * speed, direction[2] * speed];
  }
  if (params.zSource > 0) {
    // Away from a point zSource below the emitter.
    const away: Vec3 = [position[0], position[1], position[2] + params.zSource];
    const length = Math.hypot(...away) || 1;
    velocity = [away[0] / length * Math.abs(speed), away[1] / length * Math.abs(speed), away[2] / length * Math.abs(speed)];
  }
  return { position, velocity };
}

// Particles a frame emits: the whole part of the accumulated rate, carrying
// the rest to the next frame.
export function emitCount(carry: number, rate: number, seconds: number): { count: number; carry: number } {
  const total = carry + Math.max(0, rate) * Math.max(0, seconds);
  const count = Math.floor(total);
  return { count, carry: total - count };
}

// Particle and ribbon blend types as three.js-agnostic modes. Particles
// (wowdev.wiki's GL calls): 0 opaque, 1 add colour, 2 alpha, 3 alpha test,
// 4 add by alpha. Ribbons and geometry use M2 material blend modes.
export type EffectBlend = 'opaque' | 'alphaKey' | 'alpha' | 'add' | 'addColor' | 'mod';

export function particleBlend(type: number): EffectBlend {
  switch (type) {
    case 0: return 'opaque';
    case 1: return 'addColor';
    case 3: return 'alphaKey';
    case 4: return 'add';
    default: return 'alpha';
  }
}

export function materialBlend(type: number): EffectBlend {
  switch (type) {
    case 0: return 'opaque';
    case 1: return 'alphaKey';
    case 2: return 'alpha';
    case 3: return 'addColor';
    case 4: return 'add';
    case 5: case 6: return 'mod';
    default: return 'alpha';
  }
}

// The angle of a UV rotation quaternion about Z.
export function quaternionAngleZ(q: number[]): number {
  return 2 * Math.atan2(q[2] ?? 0, q[3] ?? 1);
}
