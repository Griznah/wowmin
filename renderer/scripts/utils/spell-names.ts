// Spell names from the client's Spell.dbc, fetched once per spell from the
// web server (assets/models/spell/<id>.json, built from WOWMIN_CLIENT_DATA).

const RETRY_MS = 60_000;

export class SpellNames {
  private readonly names = new Map<number, string>();
  private readonly failedAt = new Map<number, number>();
  private readonly loading = new Set<number>();

  constructor(private readonly onLoad: () => void) {}

  // The spell's name, or '' until it has loaded (or if there is none).
  get(spellId: number): string {
    const name = this.names.get(spellId);
    if (name !== undefined) return name;
    if (!this.loading.has(spellId) && Date.now() - (this.failedAt.get(spellId) ?? -Infinity) >= RETRY_MS) this.load(spellId);
    return '';
  }

  private load(spellId: number): void {
    this.loading.add(spellId);
    fetch(`assets/models/spell/${spellId}.json`)
      .then((response) => (response.ok ? response.json() : null))
      .then((spell: { name?: unknown } | null) => {
        if (typeof spell?.name === 'string') {
          this.names.set(spellId, spell.name);
          this.onLoad();
        } else {
          this.failedAt.set(spellId, Date.now());
        }
      })
      .catch(() => this.failedAt.set(spellId, Date.now()))
      .finally(() => this.loading.delete(spellId));
  }
}
