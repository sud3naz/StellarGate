/**
 * Where the followers had got to, kept across restarts.
 *
 * Without this both directions start at the tip of their chain every time the
 * process comes back. Anything burned while it was down is behind the starting
 * point and is never seen: not delayed, not retried, simply never looked at.
 * The money is not lost, the burn and Circle's attestation both outlive us, but
 * nothing delivers it and nobody is told. A deploy is enough to cause it, and
 * a deploy is the most ordinary thing that happens to this service.
 *
 * Written the way {Store} writes, to a neighbouring file and renamed, so a
 * process killed mid-write leaves either the old position or the new one and
 * never half of a number.
 *
 * The ordering that makes this correct lives in {run}: a burn is recorded in
 * the store first, and only then does the position move past it. Saving the
 * position first would trade a missed burn for a skipped one, which is the
 * same failure with better logs.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

export class Cursors {
  /**
   * @param path Where to persist. Omit for a set that lives and dies with the
   *        process, which is what tests want and what production must not have.
   */
  constructor({ path = null } = {}) {
    this.path = path;
    this.positions = new Map();
    if (path && existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        for (const [key, value] of Object.entries(raw)) {
          if (Number.isInteger(value) && value > 0) this.positions.set(key, value);
        }
      } catch {
        // A file that cannot be read is the same as no file: start from the
        // tip and say nothing, because the alternative is refusing to boot
        // over a cache. Losing the position is bad; not running is worse.
      }
    }
  }

  /** @returns the saved position, or null to mean "start wherever you would". */
  get(name) {
    return this.positions.get(name) ?? null;
  }

  /**
   * Moves a position forward. Never backward: a follower that re-read an
   * older block would deliver a burn it has already delivered, and the store
   * is the only thing standing between that and a double payment. Cheaper to
   * refuse here.
   */
  set(name, value) {
    if (!Number.isInteger(value) || value < 1) return this.get(name);
    const current = this.positions.get(name) ?? 0;
    if (value <= current) return current;
    this.positions.set(name, value);
    this.#persist();
    return value;
  }

  #persist() {
    if (!this.path) return;
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(Object.fromEntries(this.positions), null, 2));
    renameSync(temp, this.path);
  }
}
