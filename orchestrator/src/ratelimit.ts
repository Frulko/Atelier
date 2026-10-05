/** Limite les ÉCHECS de connexion par clé (IP, e-mail). En mémoire : se vide au redémarrage. */
export class FailureLimiter {
  private hits = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  constructor(max = 5, windowMs = 15 * 60_000) { this.max = max; this.windowMs = windowMs; }

  private recent(key: string, now: number) {
    const r = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (r.length) this.hits.set(key, r); else this.hits.delete(key);
    return r;
  }
  blocked(key: string, now = Date.now()) { return this.recent(key, now).length >= this.max; }
  fail(key: string, now = Date.now()) { this.hits.set(key, [...this.recent(key, now), now]); }
  reset(key: string) { this.hits.delete(key); }
}
