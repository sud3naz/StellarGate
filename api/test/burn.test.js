import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGED_TOPIC,
  UnpaidBurn,
  decodeBridged,
  verifyPaidBurn,
  assertPaidForActivation,
} from '../src/watcher/burn.js';

/**
 * A real `Bridged` log, from the Base Sepolia transfer that created
 * GAFKBZTU… out of nothing on 7 August 2026. Kept verbatim rather than
 * constructed, because a decoder tested against its own encoder agrees with
 * itself and proves nothing.
 *
 * Base Sepolia tx 0xaf406107764bab3b9e7d12142a1b67eefd9a24898f549ff404ff059cc9b00ec8
 */
const BRIDGE = '0x69752D7C3d1c7C919bc24e34cD440762F642FF00';
const RECIPIENT = 'GAFKBZTURNATMAL6KBLKBOPBRF2WZ4DKPMO6MIAUFIXVQU5EH7CHOZ5Z';
const TX = '0xaf406107764bab3b9e7d12142a1b67eefd9a24898f549ff404ff059cc9b00ec8';

const REAL_LOG = {
  address: BRIDGE.toLowerCase(),
  topics: [BRIDGED_TOPIC, '0x000000000000000000000000236407fda32b95cd5456743753f29b141eb2611a'],
  data:
    '0x00000000000000000000000000000000000000000000000000000000000000c0' +
    '000000000000000000000000000000000000000000000000000000000044aa20' +
    '0000000000000000000000000000000000000000000000000000000000168b7c' +
    '00000000000000000000000000000000000000000000000000000000002e1ea4' +
    '0000000000000000000000000000000000000000000000000000000000000030' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '0000000000000000000000000000000000000000000000000000000000000038' +
    '4741464b425a5455524e41544d414c364b424c4b424f5042524632575a34444b' +
    '504d4f364d4941554649585651553545483743484f5a355a0000000000000000',
};

/**
 * A node that answers with whatever receipt the test wants, and puts the head
 * of the chain well past it, so the default confirmation window is met.
 */
function nodeReturning(result, { head = '0x1000' } = {}) {
  return async (_url, init) => {
    const { method } = JSON.parse(init.body);
    const answer = method === 'eth_blockNumber' ? head : result;
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: answer }) };
  };
}

const SUCCESSFUL_RECEIPT = { status: '0x1', blockNumber: '0x100', logs: [REAL_LOG] };

test('decodes a real Bridged log', () => {
  const bridged = decodeBridged(REAL_LOG);

  assert.equal(bridged.stellarRecipient, RECIPIENT);
  assert.equal(bridged.gross, 4_500_000n);
  assert.equal(bridged.net, 1_477_500n);
  assert.equal(bridged.fee, 3_022_500n);
  assert.equal(bridged.activate, true);
  assert.equal(bridged.recipientVersion, 48, 'the strkey version byte for a G address');
  assert.equal(bridged.user.toLowerCase(), '0x236407fda32b95cd5456743753f29b141eb2611a');
});

test('the quoted numbers add up', () => {
  const { gross, net, fee } = decodeBridged(REAL_LOG);
  assert.equal(net + fee, gross);
});

test('a pending receipt is not an answer either way', async () => {
  const proof = await verifyPaidBurn('http://node', TX, {
    bridge: BRIDGE,
    expectedRecipient: RECIPIENT,
    fetchImpl: nodeReturning(null),
  });
  assert.equal(proof, null, 'null means ask again, not give up and not pay out');
});

test('accepts the burn that paid for this address', async () => {
  const proof = await verifyPaidBurn('http://node', TX, {
    bridge: BRIDGE,
    expectedRecipient: RECIPIENT,
    fetchImpl: nodeReturning(SUCCESSFUL_RECEIPT),
  });

  assert.equal(proof.txHash, TX);
  assert.equal(proof.stellarRecipient, RECIPIENT);
  assert.equal(proof.activate, true);
});

/**
 * The mistake this module exists for. On 7 August a burn was submitted before
 * its approve had propagated, reverted, and the setup went in anyway.
 */
test('refuses a burn that reverted', async () => {
  await assert.rejects(
    verifyPaidBurn('http://node', TX, {
      bridge: BRIDGE,
      expectedRecipient: RECIPIENT,
      fetchImpl: nodeReturning({ status: '0x0', blockNumber: '0x100', logs: [] }),
    }),
    UnpaidBurn,
  );
});

/**
 * `Bridged` is a signature, not a permission. Anyone can deploy a contract
 * that emits it with any numbers they like, so the address filter is the
 * security boundary and not a tidiness measure.
 */
test('refuses a Bridged log from somebody else’s contract', async () => {
  const impostor = { ...REAL_LOG, address: '0xdead00000000000000000000000000000000beef' };

  await assert.rejects(
    verifyPaidBurn('http://node', TX, {
      bridge: BRIDGE,
      expectedRecipient: RECIPIENT,
      fetchImpl: nodeReturning({ status: '0x1', blockNumber: '0x100', logs: [impostor] }),
    }),
    UnpaidBurn,
  );
});

/**
 * Without this, one paid burn funds an account for every address anyone cares
 * to ask about.
 */
test('refuses a burn that paid for a different address', async () => {
  await assert.rejects(
    verifyPaidBurn('http://node', TX, {
      bridge: BRIDGE,
      expectedRecipient: 'GAB4UFSIFR7DQMAUPHFYBXWBWGSDQT3Q3MTQPGMNODG3W5ITNIWJPX2U',
      fetchImpl: nodeReturning(SUCCESSFUL_RECEIPT),
    }),
    UnpaidBurn,
  );
});

test('refuses a transaction with no Bridged log at all', async () => {
  await assert.rejects(
    verifyPaidBurn('http://node', TX, {
      bridge: BRIDGE,
      expectedRecipient: RECIPIENT,
      fetchImpl: nodeReturning({ status: '0x1', blockNumber: '0x100', logs: [] }),
    }),
    UnpaidBurn,
  );
});

test('a truncated log is refused rather than half-read', () => {
  assert.throws(() => decodeBridged({ ...REAL_LOG, data: '0x00' }), UnpaidBurn);
});

// --- the gate on the XLM itself -------------------------------------------

test('refuses to spend without a proof at all', () => {
  assert.throws(() => assertPaidForActivation(undefined), UnpaidBurn);
  assert.throws(() => assertPaidForActivation({}), UnpaidBurn);
  assert.throws(() => assertPaidForActivation(true), UnpaidBurn, 'a boolean is not a proof');
});

test('refuses a real burn that did not buy an activation', () => {
  const paidButNotForThis = { txHash: TX, activate: false };
  assert.throws(() => assertPaidForActivation(paidButNotForThis), UnpaidBurn);
});

test('passes a burn that bought one', () => {
  const proof = { txHash: TX, activate: true };
  assert.equal(assertPaidForActivation(proof), proof);
});

// --- a receipt is not a burn until the chain has moved on -------------------

/**
 * On an L2 the receipt is the sequencer's word, given the moment it includes
 * the transaction, and a block can still be replaced. The setup used to go
 * out on that word alone. Now the head has to be past the burn by a few
 * blocks, or by the node's own `safe` or `finalized` mark, before any XLM
 * moves for it. Until then the answer is "not yet", the same answer a
 * missing receipt gets, and the caller comes back.
 */
test('a burn at the very tip of the chain is not proven yet', async () => {
  const proof = await verifyPaidBurn('http://node', TX, {
    bridge: BRIDGE,
    expectedRecipient: RECIPIENT,
    fetchImpl: nodeReturning(SUCCESSFUL_RECEIPT, { head: '0x102' }), // two blocks on
    confirmations: 5,
  });
  assert.equal(proof, null, 'wait, rather than spend on a block that may go');
});

test('a burn five blocks back is proven', async () => {
  const proof = await verifyPaidBurn('http://node', TX, {
    bridge: BRIDGE,
    expectedRecipient: RECIPIENT,
    fetchImpl: nodeReturning(SUCCESSFUL_RECEIPT, { head: '0x105' }),
    confirmations: 5,
  });
  assert.equal(proof?.activate, true);
});

test('the safe tag is honoured when asked for', async () => {
  const asked = [];
  const node = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    asked.push(method);
    let result = SUCCESSFUL_RECEIPT;
    if (method === 'eth_getBlockByNumber') {
      assert.equal(params[0], 'safe');
      result = { number: '0xff' }; // one short of the burn's block
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };

  const proof = await verifyPaidBurn('http://node', TX, {
    bridge: BRIDGE,
    expectedRecipient: RECIPIENT,
    fetchImpl: node,
    confirmations: 'safe',
  });
  assert.equal(proof, null, 'the burn is past the safe block, so not yet');
  assert.ok(asked.includes('eth_getBlockByNumber'));
});

test('zero confirmations trusts the receipt as given', async () => {
  const proof = await verifyPaidBurn('http://node', TX, {
    bridge: BRIDGE,
    expectedRecipient: RECIPIENT,
    fetchImpl: nodeReturning(SUCCESSFUL_RECEIPT, { head: '0x100' }),
    confirmations: 0,
  });
  assert.equal(proof?.activate, true);
});

test('a reverted burn is refused before anybody asks how deep it is', async () => {
  const asked = [];
  const node = async (_url, init) => {
    const { method } = JSON.parse(init.body);
    asked.push(method);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { status: '0x0', blockNumber: '0x100', logs: [] } }) };
  };
  await assert.rejects(
    verifyPaidBurn('http://node', TX, { bridge: BRIDGE, expectedRecipient: RECIPIENT, fetchImpl: node }),
    UnpaidBurn,
  );
  assert.deepEqual(asked, ['eth_getTransactionReceipt']);
});
