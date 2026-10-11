import { type Camera, Group } from 'three';

import type { Point3 } from '../utils/spell-events';
import { EffectInstance, type EffectTemplate, getEffectView, loadEffectTemplate } from './m2-effect';

// Game objects (battleground banners and flags, doors, chests) as the
// client's models, from the module's game object lists: each plays its idle
// loop (a banner waves, an aura glows) where the server put it, and goes
// when the server despawns it, so banners follow who holds a node. Models are
// built from the client like spell effects (assets/models/gameobject/<id>.glb).

export interface GameObjectPose {
  guid: number;
  displayId: number;
  position: Point3;
  // Turn about Z, in radians.
  yaw: number;
  scale: number;
}

const PARTICLE_BUDGET = 3000;

export class GameObjectLayer {
  readonly group = new Group();
  private readonly templates = new Map<number, EffectTemplate | null | 'loading'>();
  private readonly shown = new Map<number, { displayId: number; instance: EffectInstance }>();

  constructor(private readonly onLoaded: () => void) {
    // Server (x, y, z) Z-up becomes (x, z, -y) Y-up, as for the scene.
    this.group.rotation.x = -Math.PI / 2;
  }

  get count(): number {
    return this.shown.size;
  }

  update(poses: GameObjectPose[], now: number, camera: Camera): void {
    this.group.updateMatrixWorld(true);
    const view = getEffectView(camera, this.group);
    const budget = { left: PARTICLE_BUDGET };
    const wanted = new Set<number>();
    for (const pose of poses) {
      const template = this.template(pose.displayId);
      if (!template) continue;
      wanted.add(pose.guid);
      let entry = this.shown.get(pose.guid);
      if (entry && entry.displayId !== pose.displayId) {
        this.remove(pose.guid);
        entry = undefined;
      }
      if (!entry) {
        const instance = new EffectInstance(template, now, true);
        this.group.add(instance.root, instance.particles);
        entry = { displayId: pose.displayId, instance };
        this.shown.set(pose.guid, entry);
      }
      entry.instance.update(now, { position: pose.position, yaw: pose.yaw, scale: pose.scale }, view, this.group, budget);
    }
    for (const guid of [...this.shown.keys()]) if (!wanted.has(guid)) this.remove(guid);
  }

  private remove(guid: number): void {
    this.shown.get(guid)?.instance.dispose();
    this.shown.delete(guid);
  }

  private template(displayId: number): EffectTemplate | null | undefined {
    const known = this.templates.get(displayId);
    if (known === 'loading') return undefined;
    if (known !== undefined) return known;
    this.templates.set(displayId, 'loading');
    loadEffectTemplate(`assets/models/gameobject/${displayId}.glb`)
      .then((template) => this.templates.set(displayId, template))
      // No model for this display (a building or an invisible marker).
      .catch(() => this.templates.set(displayId, null))
      .finally(() => this.onLoaded());
    return undefined;
  }
}
