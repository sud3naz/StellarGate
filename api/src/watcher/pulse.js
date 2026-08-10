/**
 * What the follower is actually doing, so `/health` can stop guessing.
 *
 * The health endpoint used to answer `{ok: true}` without consulting anything.
 * That is true in the only case it cannot detect: the process is up. The
 * follower runs its own loop inside the same process, and a loop wedged on a
 * socket with no timeout leaves the HTTP side perfectly responsive, still
 * saying ok, while no burn on Base is being seen at all. A bridge that has
 * silently stopped watching is the worst failure this service has, and it was
 * the one failure the health check could not report.
 *
 * So the loop leaves a mark every time it completes a scan, and the endpoint
 * reads the mark. Liveness becomes "it scanned recently", which is a claim
 * about work done rather than about a process existing.
 *
 * Deliberately not a class and deliberately not global: it is created in
 * `main` and handed to both sides, so tests can make their own and nothing
 * has to be reset between them.
 */

/** @param now injectable so tests do not have to sleep. */
export function createPulse({ now = () => Date.now() } = {}) {
  const state = {
    startedAt: now(),
    // Inbound: Base to Stellar.
    cursor: null,
    lastScanAt: null,
    // Outbound: Stellar to Base. Null forever when this deployment does not
    // run that direction, which is why it is reported separately rather than
    // folded into one number.
    reverseLedger: null,
    lastReverseScanAt: null,
    // The most recent failure, kept even after a later success: a follower
    // that recovers every time but fails every other cycle is not healthy,
    // and a field that clears itself would hide that.
    lastError: null,
    lastErrorAt: null,
    errors: 0,
  };

  return {
    scanned(cursor) {
      state.cursor = cursor;
      state.lastScanAt = now();
    },
    scannedReverse(ledger) {
      state.reverseLedger = ledger;
      state.lastReverseScanAt = now();
    },
    failed(reason) {
      state.lastError = String(reason);
      state.lastErrorAt = now();
      state.errors += 1;
    },
    /**
     * @param staleAfterMs how long without a completed scan counts as stuck.
     *        The follower polls every 12s by default, so a minute is five
     *        missed cycles: long enough that a slow RPC does not cry wolf,
     *        short enough to catch a wedge before a user does.
     */
    read(staleAfterMs = 60_000) {
      const at = now();
      const sinceScan = state.lastScanAt === null ? null : at - state.lastScanAt;
      // Before the first scan lands, fall back to how long the process has
      // been up: a follower that never completed one scan is stuck too, and
      // a null age would otherwise read as healthy.
      const age = sinceScan === null ? at - state.startedAt : sinceScan;
      return {
        following: age <= staleAfterMs,
        cursor: state.cursor,
        secondsSinceScan: sinceScan === null ? null : Math.round(sinceScan / 1000),
        secondsSinceStart: Math.round((at - state.startedAt) / 1000),
        reverseLedger: state.reverseLedger,
        secondsSinceReverseScan:
          state.lastReverseScanAt === null
            ? null
            : Math.round((at - state.lastReverseScanAt) / 1000),
        errors: state.errors,
        lastError: state.lastError,
        secondsSinceError:
          state.lastErrorAt === null ? null : Math.round((at - state.lastErrorAt) / 1000),
      };
    },
  };
}
