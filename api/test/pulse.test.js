import test from 'node:test';
import assert from 'node:assert/strict';

import { createPulse } from '../src/watcher/pulse.js';
import { createHandler } from '../src/server.js';
import { Store } from '../src/watcher/store.js';

/**
 * The point of all of this is one sentence: a stopped follower must stop
 * saying it is fine. Everything below is that sentence from a few angles.
 */

/** A clock the test moves by hand, so nothing here has to sleep. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('a fresh pulse is following, on the strength of having just started', () => {
  const c = clock();
  const pulse = createPulse({ now: c.now });
  assert.equal(pulse.read().following, true);
  assert.equal(pulse.read().cursor, null);
});

test('a follower that never completes a scan goes stale on its own', () => {
  const c = clock();
  const pulse = createPulse({ now: c.now });

  // Never calls scanned(). Without the startedAt fallback this reads as
  // healthy forever, which is the exact bug being fixed: a loop that wedges
  // on its very first poll would have reported ok indefinitely.
  c.advance(61_000);
  assert.equal(pulse.read().following, false);
});

test('scanning keeps it alive and carries the cursor', () => {
  const c = clock();
  const pulse = createPulse({ now: c.now });

  c.advance(50_000);
  pulse.scanned(45_275_937);
  assert.equal(pulse.read().following, true);
  assert.equal(pulse.read().cursor, 45_275_937);
  assert.equal(pulse.read().secondsSinceScan, 0);
});

test('silence past the threshold is reported as not following', () => {
  const c = clock();
  const pulse = createPulse({ now: c.now });
  pulse.scanned(100);

  c.advance(59_000);
  assert.equal(pulse.read().following, true, '59s is still within one minute');

  c.advance(2_000);
  const state = pulse.read();
  assert.equal(state.following, false);
  assert.equal(state.secondsSinceScan, 61);
});

test('a failure is remembered even after the follower recovers', () => {
  const c = clock();
  const pulse = createPulse({ now: c.now });

  pulse.failed('rpc eth_getLogs: block range extends beyond current head block');
  c.advance(5_000);
  pulse.scanned(200);

  const state = pulse.read();
  assert.equal(state.following, true, 'it recovered, so it is following');
  assert.equal(state.errors, 1);
  assert.match(state.lastError, /beyond current head/);
  assert.equal(state.secondsSinceError, 5);
});

test('the outbound direction is tracked separately, not folded in', () => {
  const c = clock();
  const pulse = createPulse({ now: c.now });
  pulse.scanned(1);

  // A deployment that runs only one direction must not look broken because
  // the other one never reports.
  assert.equal(pulse.read().reverseLedger, null);
  assert.equal(pulse.read().secondsSinceReverseScan, null);
  assert.equal(pulse.read().following, true);

  pulse.scannedReverse(4_043_726);
  assert.equal(pulse.read().reverseLedger, 4_043_726);
});

// ---------------------------------------------------------------- /health

const handlerWith = (pulse) =>
  createHandler({ store: new Store(), verifyBurn: async () => null, pulse });

test('health without a pulse answers as it always did', async () => {
  const handle = createHandler({ store: new Store(), verifyBurn: async () => null });
  const res = await handle({ method: 'GET', path: '/health' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.watcher, undefined);
});

test('health reports ok while the follower is scanning', async () => {
  const c = clock();
  const pulse = createPulse({ now: c.now });
  pulse.scanned(45_275_937);

  const res = await handlerWith(pulse)({ method: 'GET', path: '/health' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.watcher.cursor, 45_275_937);
  assert.equal(res.body.pending, 0);
});

test('health turns red and answers 503 once the follower goes quiet', async () => {
  const c = clock();
  const pulse = createPulse({ now: c.now });
  pulse.scanned(45_275_937);
  c.advance(120_000);

  const res = await handlerWith(pulse)({ method: 'GET', path: '/health' });
  assert.equal(res.status, 503, 'a monitor that only reads status codes must see this');
  assert.equal(res.body.ok, false);
  assert.equal(res.body.watcher.secondsSinceScan, 120);
});
