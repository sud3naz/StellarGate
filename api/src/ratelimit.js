/**
 * How often one caller may make the watcher do work.
 *
 * Three routes cost something to answer. `/setup` is three Horizon reads and
 * a channel signature, and it holds a channel for the length of a setup.
 * `/outbound` is a Soroban simulation. `/transfers` is a read of the source
 * chain. None of them asks who is calling, so without a limit the cheapest
 * way to take the bridge down is a loop: Horizon rate-limits the watcher's
 * address, and from then on every real user's setup fails with the same 429
 * the attacker earned. The channel pool is the same story, one `/setup` per
 * recipient holds a channel for forty-five minutes.
 *
 * Two limits, both sliding windows. One per caller, which is what stops the
 * loop. One for everybody together, which is what keeps Horizon's per-address
 * budget from being spent by a crowd of callers who are each within their
 * own. The second is the one that matters when the first is being evaded
 * with many addresses.
 *
 * In-process on purpose. Caddy can do this too, but only if built with a
 * plugin, and a limit that lives in the code is one that is there whichever
 * proxy is in front. If both are in place, both apply, and that is fine.
 */

export class RateLimited extends Error {
  constructor(message, retryAfterSeconds) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * @param perKey  `{ limit, windowMs }` for each caller.
 * @param global  `{ limit, windowMs }` for everybody at once. Optional.
 * @param now     A clock, for tests.
 */
export function createLimiter({ perKey, global = null, now = () => Date.now() } = {}) {
  if (!perKey?.limit || !perKey?.windowMs) throw new Error('a limiter needs a per-caller limit');

  /// key -> timestamps of recent hits, oldest first.
  const hits = new Map();
  const everybody = [];

  function prune(list, windowMs, at) {
    while (list.length && list[0] <= at - windowMs) list.shift();
  }

  /**
   * Records a hit for `key` and says whether it was within the limits.
   * @returns `{ ok: true }` or `{ ok: false, retryAfterSeconds, scope }`.
   */
  function take(key) {
    const at = now();

    if (global) {
      prune(everybody, global.windowMs, at);
      if (everybody.length >= global.limit) {
        const retry = Math.ceil((everybody[0] + global.windowMs - at) / 1000);
        return { ok: false, retryAfterSeconds: Math.max(1, retry), scope: 'everyone' };
      }
    }

    let mine = hits.get(key);
    if (!mine) {
      mine = [];
      hits.set(key, mine);
    }
    prune(mine, perKey.windowMs, at);
    if (mine.length >= perKey.limit) {
      const retry = Math.ceil((mine[0] + perKey.windowMs - at) / 1000);
      return { ok: false, retryAfterSeconds: Math.max(1, retry), scope: 'you' };
    }

    mine.push(at);
    if (global) everybody.push(at);

    // Forgetting quiet callers keeps the map from growing with every address
    // that ever asked once.
    if (hits.size > 10_000) {
      for (const [k, list] of hits) {
        prune(list, perKey.windowMs, at);
        if (!list.length) hits.delete(k);
      }
    }
    return { ok: true };
  }

  /** Throws {RateLimited} instead of returning a refusal. */
  function assertAllowed(key, what = 'this') {
    const verdict = take(key);
    if (!verdict.ok) {
      throw new RateLimited(
        verdict.scope === 'everyone'
          ? `the bridge is busy; try ${what} again in ${verdict.retryAfterSeconds}s`
          : `too many requests; try ${what} again in ${verdict.retryAfterSeconds}s`,
        verdict.retryAfterSeconds,
      );
    }
  }

  return { take, assertAllowed };
}
