import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MESSAGE_TRANSMITTER,
  STELLAR_DOMAIN,
  classifyClaimFailure,
  fetchStellarBurns,
  reverseStep,
} from '../src/watcher/reverse.js';
import { Store } from '../src/watcher/store.js';

/// The real burn, from the Stellar-to-Base transfer on 7 August 2026.
const TX = 'cf745fd80751449d3f81fa91930dfb2f6f828e504d4d6dd06c7321c576dc8737';
const CONTRACT = 'CCWMXUFXXYL6HEL4BYXRPLUXPGI2DEYEOP7TZX7EXWZBOM7WAWWDMWHR';
const RECIPIENT = '0x236407FdA32b95CD5456743753f29B141EB2611A';

function soroban(result) {
  return async (_url, init) => {
    const call = JSON.parse(init.body);
    assert.equal(call.method, 'getEvents');
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
}

test('Stellar is domain 27 and the transmitter is where Circle says', () => {
  assert.equal(STELLAR_DOMAIN, 27);
  assert.equal(MESSAGE_TRANSMITTER.testnet, '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275');
});

test('reads burns out of the contract', async () => {
  const { burns, cursor } = await fetchStellarBurns('http://rpc', {
    contractId: CONTRACT,
    startLedger: 100,
    fetchImpl: soroban({
      events: [{ txHash: TX, ledger: 123, contractId: CONTRACT }],
      cursor: 'abc',
    }),
  });

  assert.equal(burns.length, 1);
  assert.equal(burns[0].txHash, TX);
  assert.equal(cursor, 'abc', 'the cursor is opaque and has to be kept');
});

test('asks only about our contract', async () => {
  let asked = null;
  await fetchStellarBurns('http://rpc', {
    contractId: CONTRACT,
    startLedger: 100,
    fetchImpl: async (_url, init) => {
      asked = JSON.parse(init.body).params;
      return { ok: true, json: async () => ({ result: { events: [] } }) };
    },
  });

  assert.deepEqual(asked.filters, [{ type: 'contract', contractIds: [CONTRACT] }]);
  assert.equal(asked.startLedger, 100);
});

/// Soroban's cursor is not a ledger number and cannot be rebuilt from one.
test('a cursor replaces the starting ledger rather than joining it', async () => {
  let asked = null;
  await fetchStellarBurns('http://rpc', {
    contractId: CONTRACT,
    cursor: 'somewhere',
    startLedger: 100,
    fetchImpl: async (_url, init) => {
      asked = JSON.parse(init.body).params;
      return { ok: true, json: async () => ({ result: { events: [] } }) };
    },
  });

  assert.equal(asked.pagination.cursor, 'somewhere');
  assert.equal(asked.startLedger, undefined, 'asking for both is asking for nothing');
});

// --- the claim -----------------------------------------------------------

const READY = { ready: true, message: 'deadbeef', attestation: 'c0ffee' };

function harness(overrides = {}) {
  const store = new Store();
  const calls = [];
  return {
    store,
    calls,
    deps: {
      store,
      attest: async () => READY,
      claim: async (message, attestation) => {
        calls.push({ message, attestation });
        return { ok: true, hash: '0xclaimed' };
      },
      ...overrides,
    },
  };
}

test('an attested burn is claimed on the EVM side', async () => {
  const { store, deps, calls } = harness();
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT });

  const result = await reverseStep(transfer, deps);

  assert.equal(result.action, 'claimed');
  assert.equal(store.get(TX).deliveredAt.stellarTxHash, '0xclaimed');
  assert.equal(calls.length, 1);
});

/// The Stellar side wanted the hex bare; the EVM side wants it prefixed. A
/// message handed over without the prefix is not a message.
test('the message is prefixed on the way out', async () => {
  const { store, deps, calls } = harness();
  await reverseStep(store.remember({ txHash: TX, recipient: RECIPIENT }), deps);

  assert.equal(calls[0].message, '0xdeadbeef');
  assert.equal(calls[0].attestation, '0xc0ffee');
});

test('nothing is claimed before Circle has attested', async () => {
  const { store, deps, calls } = harness({ attest: async () => ({ ready: false }) });

  const result = await reverseStep(store.remember({ txHash: TX, recipient: RECIPIENT }), deps);

  assert.equal(result.action, 'wait');
  assert.equal(calls.length, 0);
});

test('a refused claim is retried and not written off', async () => {
  const { store, deps } = harness({
    claim: async () => ({ ok: false, retryable: true, reason: 'the node was busy' }),
  });

  const result = await reverseStep(store.remember({ txHash: TX, recipient: RECIPIENT }), deps);

  assert.equal(result.action, 'retry-claim');
  assert.equal(store.pending().length, 1, 'it stays on the queue');
});

test('a message already used is recorded rather than retried forever', async () => {
  const { store, deps } = harness({
    claim: async () => ({ ok: false, done: true, reason: 'already claimed' }),
  });

  const result = await reverseStep(store.remember({ txHash: TX, recipient: RECIPIENT }), deps);

  assert.equal(result.action, 'done');
  assert.equal(store.pending().length, 0);
});

test('a claimed transfer is left alone', async () => {
  const { store, deps, calls } = harness();
  store.remember({ txHash: TX, recipient: RECIPIENT });
  store.markDelivered(TX, '0xclaimed');

  await reverseStep(store.get(TX), deps);
  assert.equal(calls.length, 0);
});

// --- what a refusal means ------------------------------------------------

test('an unrecognised failure is retried, because giving up is the expensive mistake', () => {
  assert.equal(classifyClaimFailure(new Error('connection reset')).retryable, true);
});

test('a used nonce is finished', () => {
  const verdict = classifyClaimFailure(new Error('execution reverted: nonce already used'));
  assert.equal(verdict.done, true);
  assert.equal(verdict.retryable, false);
});

/**
 * A message the transmitter will never accept is not worth an hour of
 * retries — it is worth telling somebody about.
 */
test('a message the transmitter rejects outright asks for a person', () => {
  const verdict = classifyClaimFailure(new Error('execution reverted: Invalid attestation length'));
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.needsHuman, true);
});
