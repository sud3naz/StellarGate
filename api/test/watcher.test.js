import test from 'node:test';
import assert from 'node:assert/strict';

import { step, sweep } from '../src/watcher/index.js';
import { Store } from '../src/watcher/store.js';
import { classifyFailure } from '../src/watcher/deliver.js';

const TX = '0xaf406107764bab3b9e7d12142a1b67eefd9a24898f549ff404ff059cc9b00ec8';
const RECIPIENT = 'GAFKBZTURNATMAL6KBLKBOPBRF2WZ4DKPMO6MIAUFIXVQU5EH7CHOZ5Z';

const PAID_ACTIVATION = { txHash: TX, stellarRecipient: RECIPIENT, activate: true };
const READY = { ready: true, message: 'deadbeef', attestation: 'c0ffee', fellBackToStandard: false };

/** A watcher whose every dependency answers as told, and counts being asked. */
function harness(overrides = {}) {
  const calls = { setups: 0, deliveries: 0 };
  const store = new Store();

  const deps = {
    store,
    verifyBurn: async () => PAID_ACTIVATION,
    submitSetup: async () => {
      calls.setups += 1;
      return { ok: true };
    },
    attest: async () => READY,
    deliver: async () => {
      calls.deliveries += 1;
      return { ok: true, hash: 'stellar-hash' };
    },
    ...overrides,
  };

  return { store, deps, calls };
}

test('a transfer with everything in place is provisioned and delivered', async () => {
  const { store, deps, calls } = harness();
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const result = await step(transfer, deps);

  assert.equal(result.action, 'delivered');
  assert.equal(calls.setups, 1);
  assert.equal(calls.deliveries, 1);
  assert.equal(store.get(TX).deliveredAt.stellarTxHash, 'stellar-hash');
});

/**
 * The step that was skipped by hand on 7 August. Nothing may be spent, and
 * nothing may be delivered, until the burn has been read off the chain.
 */
test('an unproven burn spends nothing', async () => {
  const { store, deps, calls } = harness({ verifyBurn: async () => null });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const result = await step(transfer, deps);

  assert.equal(result.action, 'wait');
  assert.equal(calls.setups, 0, 'no XLM moves for a burn nobody has seen');
  assert.equal(calls.deliveries, 0);
});

test('a burn that cannot be verified stops the transfer rather than the loop', async () => {
  const { store, deps } = harness({
    verifyBurn: async () => {
      throw new Error('burn reverted');
    },
  });
  store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const [result] = await sweep(deps);
  assert.equal(result.action, 'error');
  assert.match(result.reason, /reverted/);
});

/**
 * The three-XLM-per-tab attack, arriving as a retry loop. However many times
 * this runs, one burn buys one activation.
 */
test('running twenty times against one burn submits one setup', async () => {
  const { store, deps, calls } = harness();
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });
  // Never finishes, so the transfer stays pending and keeps being swept.
  deps.attest = async () => ({ ready: false });

  for (let i = 0; i < 20; i += 1) await step(store.get(TX) ?? transfer, deps);

  assert.equal(calls.setups, 1, 'the claim held');
});

/**
 * A claim already held means an earlier pass took it and never reported
 * back, a crash between claiming and hearing from Horizon. The only safe
 * move is to send the *same* envelope again: same hash, same sequence, and
 * the ledger applies it at most once. What used to happen here was worse than
 * either option: the transfer was marked provisioned on the strength of an
 * attempt whose outcome nobody knew, and delivery then retried forever into
 * an account that had never been created.
 */
test('a claim held by an attempt that never reported back is resubmitted, not assumed', async () => {
  const sent = [];
  const { store, deps } = harness({
    submitSetup: async (xdr) => {
      sent.push(xdr);
      return { ok: true };
    },
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });
  store.claimActivation(TX); // taken, and then the process died

  const result = await step(transfer, deps);

  assert.deepEqual(sent, ['XDR'], 'the same bytes, which the ledger takes once');
  assert.equal(store.get(TX).provisioned, true);
  assert.equal(result.action, 'delivered');
});

/**
 * A setup the ledger will never take, because its sequence number went to
 * another transfer or its time bound passed, is dropped rather than retried,
 * and the activation it was going to spend goes back to the burn, so the
 * next setup the user signs can have it.
 */
test('a dead setup is dropped, and the burn keeps its activation', async () => {
  const { store, deps, calls } = harness({
    submitSetup: async () => ({ ok: false, dead: true, transactionCode: 'tx_bad_seq' }),
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const result = await step(transfer, deps);

  assert.equal(result.action, 'setup-dead');
  assert.match(result.reason, /tx_bad_seq/);
  const record = store.get(TX);
  assert.equal(record.setupXdr, null, 'nothing left to retry');
  assert.equal(record.provisioned, false, 'and nothing was pretended');
  assert.equal(record.activationClaimed, false, 'the activation is unspent');
  assert.match(record.setupFailure.reason, /tx_bad_seq/);
  assert.equal(calls.deliveries, 0);

  // The page asks the user again and posts the new one, which is taken.
  store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR-2' });
  deps.submitSetup = async () => {
    calls.setups += 1;
    return { ok: true };
  };
  const next = await step(store.get(TX), deps);

  assert.equal(next.action, 'delivered');
  assert.equal(calls.setups, 1, 'the fresh setup went out once');
  assert.equal(store.get(TX).setupFailure, null);
});

/// A dead setup is one Horizon has been asked about. Anything less is a retry.
test('a refusal that is not final keeps the setup and the claim', async () => {
  const { store, deps } = harness({
    submitSetup: async () => ({ ok: false, dead: false, transactionCode: 'tx_insufficient_fee' }),
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const result = await step(transfer, deps);

  assert.equal(result.action, 'retry-setup');
  assert.equal(store.get(TX).setupXdr, 'XDR');
  assert.equal(store.get(TX).activationClaimed, true);
});

/**
 * A destination that can pay its own reserve owes nothing, so the trustline is
 * not gated behind a claim it never had to make.
 */
test('a trustline-only setup needs no claim', async () => {
  const { store, deps, calls } = harness({
    verifyBurn: async () => ({ txHash: TX, stellarRecipient: RECIPIENT, activate: false }),
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  await step(transfer, deps);

  assert.equal(calls.setups, 1);
  assert.equal(store.get(TX).activationClaimed, false, 'nothing of ours was spent');
});

test('provisioning happens before the attestation is even asked for', async () => {
  const order = [];
  const { store, deps } = harness({
    submitSetup: async () => {
      order.push('setup');
      return { ok: true };
    },
    attest: async () => {
      order.push('attest');
      return READY;
    },
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  await step(transfer, deps);

  assert.deepEqual(order, ['setup', 'attest'], 'fifteen seconds of margin is not slack');
});

test('a pending attestation is waited on, not delivered', async () => {
  const { store, deps, calls } = harness({
    attest: async () => ({ ready: false, delayReason: 'insufficient_fee' }),
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const result = await step(transfer, deps);

  assert.equal(result.action, 'wait');
  assert.match(result.reason, /insufficient_fee/, 'the reason belongs in the log');
  assert.equal(calls.deliveries, 0);
});

test('a losing setup is retried rather than written off', async () => {
  const { store, deps } = harness({
    submitSetup: async () => ({ ok: false, operationCodes: ['op_underfunded'] }),
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const result = await step(transfer, deps);

  assert.equal(result.action, 'retry-setup');
  assert.match(result.reason, /op_underfunded/);
  assert.equal(store.get(TX).provisioned, false);
});

/// Losing the race is not a failure: the address ended up usable either way.
test('a setup that was already done counts as provisioned', async () => {
  const { store, deps } = harness({
    submitSetup: async () => ({ ok: false, alreadyDone: true }),
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  await step(transfer, deps);
  assert.equal(store.get(TX).provisioned, true);
});

test('a refused delivery is retried and not marked done', async () => {
  const { store, deps } = harness({
    deliver: async () => ({ ok: false, retryable: true, reason: 'no trustline yet' }),
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const result = await step(transfer, deps);

  assert.equal(result.action, 'retry-delivery');
  assert.equal(store.get(TX).deliveredAt, null);
  assert.equal(store.pending().length, 1, 'it stays on the queue');
});

/// The message was consumed, so an earlier attempt landed. Nothing to redo.
test('a message already used is recorded, not retried forever', async () => {
  const { store, deps } = harness({
    deliver: async () => ({ ok: false, done: true, reason: 'already delivered' }),
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const result = await step(transfer, deps);

  assert.equal(result.action, 'done');
  assert.equal(store.pending().length, 0);
});

test('a fallback to hard finality is delivered and said out loud', async () => {
  const { store, deps } = harness({
    attest: async () => ({ ...READY, fellBackToStandard: true }),
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const result = await step(transfer, deps);

  assert.equal(result.action, 'delivered');
  assert.match(result.reason, /slow road/);
});

test('a delivered transfer is left alone', async () => {
  const { store, deps, calls } = harness();
  store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });
  store.markDelivered(TX, 'stellar-hash');

  const result = await step(store.get(TX), deps);

  assert.equal(result.action, 'done');
  assert.equal(calls.deliveries, 0);
});

test('one broken transfer does not stop the others', async () => {
  const { store, deps } = harness({
    verifyBurn: async (txHash) => {
      if (txHash === '0xbad') throw new Error('rpc exploded');
      return PAID_ACTIVATION;
    },
  });
  store.remember({ txHash: '0xbad', recipient: RECIPIENT, setupXdr: 'XDR' });
  store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const results = await sweep(deps);

  assert.equal(results.length, 2);
  assert.equal(results.find((r) => r.txHash === '0xbad').action, 'error');
  assert.equal(results.find((r) => r.txHash === TX).action, 'delivered');
});

// --- what a refusal from Stellar means ------------------------------------

/**
 * The asymmetry that sets the default: a wrongly-retried delivery costs a
 * transaction fee, a wrongly-abandoned one costs the user everything they
 * sent. The message is not consumed by a failure, so being late is free.
 */
test('an unrecognised failure is retried, because giving up is the expensive mistake', () => {
  assert.equal(classifyFailure(new Error('something nobody has seen')).retryable, true);
});

test('a missing trustline is a wait, not a loss', () => {
  const verdict = classifyFailure(new Error('HostError: TrustlineMissing'));
  assert.equal(verdict.retryable, true);
  assert.match(verdict.reason, /trustline/i);
});

/**
 * The real refusal, taken verbatim from replaying an already-delivered
 * message against Circle's forwarder on testnet. The first version of
 * classifyFailure searched for the words "already used" and read this as
 * retryable, which would have had the watcher redeliver a finished transfer
 * until it gave up an hour later.
 *
 * 6908 is NonceAlreadyUsed, read from the MessageTransmitter's own error enum
 * on chain rather than inferred.
 */
test('a consumed nonce is finished, and it only says so in numbers', () => {
  const real =
    'HostError: Error(Contract, #6908)\n\nEvent log (newest first):\n   0: [Diagnostic Event] ' +
    'contract:CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ, topics:[error, Error(Contract, #6908)]';

  const verdict = classifyFailure(new Error(real));
  assert.equal(verdict.done, true);
  assert.equal(verdict.retryable, false);
});

test('a malformed message asks for a person instead of another attempt', () => {
  const verdict = classifyFailure(new Error('HostError: Error(Contract, #7303)'));
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.needsHuman, true, 'retrying this forever tells nobody');
});

test('a pause is waited out', () => {
  const verdict = classifyFailure(new Error('HostError: Error(Contract, #1000)'));
  assert.equal(verdict.retryable, true);
  assert.match(verdict.reason, /paused/i);
});

/**
 * The funder's own refusal, for a setup that got into the store without
 * passing the door. It is dropped like a dead one: nothing was spent, the
 * activation is unclaimed, and the reason is there to read.
 */
test('a setup the funder refuses to sign is dropped, not retried', async () => {
  const { ForeignSetup } = await import('../src/stellar/verify.js');
  const { store, deps, calls } = harness({
    submitSetup: async () => {
      throw new ForeignSetup('refusing to sign this setup: it pays the wrong person');
    },
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'THEIRS' });

  const result = await step(transfer, deps);

  assert.equal(result.action, 'setup-refused');
  assert.equal(store.get(TX).setupXdr, null);
  assert.equal(store.get(TX).activationClaimed, false);
  assert.match(store.get(TX).setupFailure.reason, /wrong person/);
  assert.equal(calls.deliveries, 0);
});
