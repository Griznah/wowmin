// Spell names, and whether each spell taunts, from the client's Spell.dbc,
// fetched once per spell from the web server (assets/models/spell/<id>.json,
// built from WOWMIN_CLIENT_DATA).

const RETRY_MS = 60_000;

interface SpellInfo {
  name: string;
  taunt: boolean;
}

export class SpellNames {
  private readonly spells = new Map<number, SpellInfo>();
  private readonly failedAt = new Map<number, number>();
  private readonly loading = new Set<number>();

  constructor(private readonly onLoad: () => void) {}

  // The spell's name, or '' until it has loaded (or if there is none).
  get(spellId: number): string {
    return this.info(spellId)?.name ?? '';
  }

  // Whether the spell taunts (Challenging Shout, a ghoul's taunt); false
  // until it has loaded.
  isTaunt(spellId: number): boolean {
    return this.info(spellId)?.taunt ?? false;
  }

  private info(spellId: number): SpellInfo | undefined {
    const spell = this.spells.get(spellId);
    if (spell) return spell;
    if (!this.loading.has(spellId) && Date.now() - (this.failedAt.get(spellId) ?? -Infinity) >= RETRY_MS) this.load(spellId);
    return undefined;
  }

  private load(spellId: number): void {
    this.loading.add(spellId);
    fetch(`assets/models/spell/${spellId}.json`)
      .then((response) => (response.ok ? response.json() : null))
      .then((spell: { name?: unknown; taunt?: unknown } | null) => {
        if (typeof spell?.name === 'string') {
          this.spells.set(spellId, { name: spell.name, taunt: spell.taunt === true });
          this.onLoad();
        } else {
          this.failedAt.set(spellId, Date.now());
        }
      })
      .catch(() => this.failedAt.set(spellId, Date.now()))
      .finally(() => this.loading.delete(spellId));
  }
}
