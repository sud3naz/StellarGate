import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IRIS,
  fetchAttestation,
  nextPollSeconds,
  stillWorthWaiting,
} from '../src/watcher/attestation.js';

const TX = '0xaf406107764bab3b9e7d12142a1b67eefd9a24898f549ff404ff059cc9b00ec8';

function iris(body, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

/**
 * Shapes taken from Circle's sandbox on 7 August 2026 rather than from the
 * documentation, because the fields that mattered most — `delayReason`, and
 * `finalityThresholdExecuted` disagreeing with what was requested — are not
 * the ones the docs lead with.
 */
const PENDING = {
  messages: [{ status: 'pending_confirmations', attestation: 'PENDING', delayReason: null }],
};

const INSUFFICIENT_FEE = {
  messages: [
    { status: 'pending_confirmations', attestation: 'PENDING', delayReason: 'insufficient_fee' },
  ],
};

const FAST_COMPLETE = {
  messages: [
    {
      status: 'complete',
      message: '0xdeadbeef',
      attestation: '0xc0ffee',
      delayReason: null,
      decodedMessage: { minFinalityThreshold: '1000', finalityThresholdExecuted: '1000' },
    },
  ],
};

/// The one that was asked for fast and got hard finality instead.
const FELL_BACK = {
  messages: [
    {
      status: 'complete',
      message: '0xdeadbeef',
      attestation: '0xc0ffee',
      delayReason: 'insufficient_fee',
      decodedMessage: { minFinalityThreshold: '1000', finalityThresholdExecuted: '2000' },
    },
  ],
};

test('a burn Circle has not indexed yet is not a burn that failed', async () => {
  assert.equal(await fetchAttestation(IRIS.testnet, 6, TX, { fetchImpl: iris({}, 404) }), null);
  assert.equal(
    await fetchAttestation(IRIS.testnet, 6, TX, { fetchImpl: iris({ messages: [] }) }),
    null,
  );
});

test('pending is pending', async () => {
  const a = await fetchAttestation(IRIS.testnet, 6, TX, { fetchImpl: iris(PENDING) });
  assert.equal(a.ready, false);
  assert.equal(a.attestation, null, 'the literal string PENDING is not an attestation');
});

test('a completed fast attestation carries what the mint needs', async () => {
  const a = await fetchAttestation(IRIS.testnet, 6, TX, { fetchImpl: iris(FAST_COMPLETE) });

  assert.equal(a.ready, true);
  assert.equal(a.message, 'deadbeef', 'no 0x: the Stellar side wants raw hex');
  assert.equal(a.attestation, 'c0ffee');
  assert.equal(a.finalityExecuted, 1000);
  assert.equal(a.fellBackToStandard, false);
});

/**
 * Measured, not assumed: a burn with too small a `maxFee` reported this for
 * twenty minutes and then attested at hard finality and delivered in full. A
 * watcher that reads it as a failure abandons money that was going to arrive.
 */
test('insufficient_fee is a delay and not a loss', async () => {
  const a = await fetchAttestation(IRIS.testnet, 6, TX, { fetchImpl: iris(INSUFFICIENT_FEE) });

  assert.equal(a.ready, false);
  assert.equal(a.delayReason, 'insufficient_fee');
  assert.equal(stillWorthWaiting(a, { elapsedSeconds: 20 * 60 }), true);
});

test('a fast transfer that fell back is still a delivery', async () => {
  const a = await fetchAttestation(IRIS.testnet, 6, TX, { fetchImpl: iris(FELL_BACK) });

  assert.equal(a.ready, true);
  assert.equal(a.finalityRequested, 1000);
  assert.equal(a.finalityExecuted, 2000);
  assert.equal(a.fellBackToStandard, true, 'worth reporting: this one took minutes, not seconds');
  assert.equal(a.message, 'deadbeef');
});

// --- how hard to poll ----------------------------------------------------

test('a fast transfer is polled tightly, because it is about to land', () => {
  assert.equal(nextPollSeconds({ ready: false }, { elapsedSeconds: 5 }), 5);
});

test('once Circle says the fee was short, the answer is minutes away', () => {
  assert.equal(nextPollSeconds({ ready: false, delayReason: 'insufficient_fee' }), 60);
});

test('past the fast window there is nothing to hurry for', () => {
  assert.equal(nextPollSeconds({ ready: false }, { elapsedSeconds: 120 }), 60);
});

test('a ready attestation is not polled again', () => {
  assert.equal(nextPollSeconds({ ready: true }), 0);
  assert.equal(stillWorthWaiting({ ready: true }, { elapsedSeconds: 1 }), false);
});

/**
 * Hard finality took twenty-five minutes on testnet, so the give-up point has
 * to be well past that — a loop that stops at twenty minutes stops on the
 * ordinary case.
 */
test('waiting continues well past the hard-finality window', () => {
  assert.equal(stillWorthWaiting(null, { elapsedSeconds: 25 * 60 }), true);
  assert.equal(stillWorthWaiting(null, { elapsedSeconds: 61 * 60 }), false, 'then a human looks');
});
