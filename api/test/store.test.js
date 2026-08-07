import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store, DoublePayment } from '../src/watcher/store.js';

const TX = '0xaf406107764bab3b9e7d12142a1b67eefd9a24898f549ff404ff059cc9b00ec8';
const RECIPIENT = 'GAFKBZTURNATMAL6KBLKBOPBRF2WZ4DKPMO6MIAUFIXVQU5EH7CHOZ5Z';
const OTHER = 'GAB4UFSIFR7DQMAUPHFYBXWBWGSDQT3Q3MTQPGMNODG3W5ITNIWJPX2U';

function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-store-'));
  return { path: join(dir, 'transfers.json'), cleanup: () => rmSync(dir, { recursive: true }) };
}

test('a burn can be claimed once', () => {
  const store = new Store();
  store.remember({ txHash: TX, recipient: RECIPIENT });

  assert.equal(store.claimActivation(TX), true, 'the first caller gets it');
  assert.equal(store.claimActivation(TX), false, 'and nobody else does');
});

/**
 * The attack this is for: an endpoint that funds Stellar accounts costs three
 * XLM per call to drain, so one payment must not be able to buy a hundred.
 */
test('a loop against one burn buys exactly one activation', () => {
  const store = new Store();
  store.remember({ txHash: TX, recipient: RECIPIENT });

  const granted = Array.from({ length: 100 }, () => store.claimActivation(TX)).filter(Boolean);
  assert.equal(granted.length, 1);
});

test('claiming a burn nobody recorded is refused, not allowed', () => {
  const store = new Store();
  assert.throws(() => store.claimActivation(TX), DoublePayment);
});

/// Logs get re-read after a restart. Seeing the same transfer again is normal.
test('remembering the same transfer twice does not disturb it', () => {
  const store = new Store();
  store.remember({ txHash: TX, recipient: RECIPIENT });
  store.claimActivation(TX);

  const again = store.remember({ txHash: TX, recipient: RECIPIENT });
  assert.equal(again.activationClaimed, true, 'the claim survives being re-seen');
  assert.equal(store.claimActivation(TX), false);
});

test('the same burn cannot be recorded against a second address', () => {
  const store = new Store();
  store.remember({ txHash: TX, recipient: RECIPIENT });

  assert.throws(() => store.remember({ txHash: TX, recipient: OTHER }), DoublePayment);
});

test('a setup arriving later is filled in', () => {
  const store = new Store();
  store.remember({ txHash: TX, recipient: RECIPIENT });
  const filled = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'AAAA' });

  assert.equal(filled.setupXdr, 'AAAA');
});

// --- surviving a restart, which is the other half of the claim ------------

/**
 * A claim held only in memory is not a claim. If the process can restart and
 * forget what it has already paid for, the loop above works — it just needs a
 * crash between iterations.
 */
test('a claim survives the process that made it', () => {
  const { path, cleanup } = temporary();
  try {
    const before = new Store({ path });
    before.remember({ txHash: TX, recipient: RECIPIENT });
    assert.equal(before.claimActivation(TX), true);

    const after = new Store({ path });
    assert.equal(after.claimActivation(TX), false, 'restarting does not buy a second activation');
  } finally {
    cleanup();
  }
});

test('deliveries survive a restart too', () => {
  const { path, cleanup } = temporary();
  try {
    const before = new Store({ path });
    before.remember({ txHash: TX, recipient: RECIPIENT });
    before.markDelivered(TX, 'stellar-hash');

    const after = new Store({ path });
    assert.equal(after.pending().length, 0, 'a delivered transfer is not work');
    assert.equal(after.get(TX).deliveredAt.stellarTxHash, 'stellar-hash');
  } finally {
    cleanup();
  }
});

test('what is pending is what has not been delivered', () => {
  const store = new Store();
  store.remember({ txHash: TX, recipient: RECIPIENT });
  store.remember({ txHash: '0xbb', recipient: OTHER });

  assert.equal(store.pending().length, 2);
  store.markDelivered(TX, 'stellar-hash');
  assert.deepEqual(
    store.pending().map((t) => t.txHash),
    ['0xbb'],
  );
});

test('provisioning is remembered so it is not repeated', () => {
  const store = new Store();
  store.remember({ txHash: TX, recipient: RECIPIENT });
  assert.equal(store.get(TX).provisioned, false);

  store.markProvisioned(TX);
  assert.equal(store.get(TX).provisioned, true);
});
