import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchBridgedLogs, followBridged, latestBlock } from '../src/watcher/logs.js';
import { BRIDGED_TOPIC } from '../src/watcher/burn.js';

const BRIDGE = '0x69752D7C3d1c7C919bc24e34cD440762F642FF00';
const RECIPIENT = 'GAFKBZTURNATMAL6KBLKBOPBRF2WZ4DKPMO6MIAUFIXVQU5EH7CHOZ5Z';
const TX = '0xaf406107764bab3b9e7d12142a1b67eefd9a24898f549ff404ff059cc9b00ec8';

/// The same real log the decoder is tested against, with the fields eth_getLogs
/// adds when it is read out of a range rather than out of a receipt.
const REAL_LOG = {
  address: BRIDGE.toLowerCase(),
  transactionHash: TX,
  blockNumber: '0x2b15033',
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

/** A node that answers each JSON-RPC method from a table, and records asks. */
function node(answers) {
  const asked = [];
  const fetchImpl = async (_url, init) => {
    const call = JSON.parse(init.body);
    asked.push(call);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: answers[call.method] }) };
  };
  return { fetchImpl, asked };
}

test('reads the tip', async () => {
  const { fetchImpl } = node({ eth_blockNumber: '0x2b15033' });
  assert.equal(await latestBlock('http://node', { fetchImpl }), 45174835);
});

test('decodes burns out of a range', async () => {
  const { fetchImpl } = node({ eth_getLogs: [REAL_LOG] });
  const burns = await fetchBridgedLogs('http://node', {
    bridge: BRIDGE,
    fromBlock: 1,
    toBlock: 100,
    fetchImpl,
  });

  assert.equal(burns.length, 1);
  assert.equal(burns[0].txHash, TX);
  assert.equal(burns[0].blockNumber, 45174835);
  assert.equal(burns[0].stellarRecipient, RECIPIENT);
  assert.equal(burns[0].activate, true);
});

test('asks only for our contract and only for Bridged', async () => {
  const { fetchImpl, asked } = node({ eth_getLogs: [] });
  await fetchBridgedLogs('http://node', { bridge: BRIDGE, fromBlock: 5, toBlock: 9, fetchImpl });

  const [filter] = asked[0].params;
  assert.equal(filter.address, BRIDGE);
  assert.deepEqual(filter.topics, [BRIDGED_TOPIC]);
  assert.equal(filter.fromBlock, '0x5');
  assert.equal(filter.toBlock, '0x9');
});

// --- the cursor ----------------------------------------------------------

/**
 * A cursor that runs to the tip can be overtaken by a reorg, and a burn that
 * disappears from under it is never looked at again. Staying a few blocks
 * back costs seconds.
 */
test('stays behind the tip', async () => {
  const { fetchImpl, asked } = node({ eth_blockNumber: '0x64', eth_getLogs: [] });
  const result = await followBridged('http://node', {
    bridge: BRIDGE,
    cursor: 50,
    confirmations: 3,
    onBurn: async () => {},
    fetchImpl,
  });

  assert.equal(result.cursor, 97, 'the tip is 100; three back is as far as it will trust');
  const [filter] = asked.find((c) => c.method === 'eth_getLogs').params;
  assert.equal(filter.toBlock, '0x61');
});

test('does nothing when there is nothing settled to read', async () => {
  const { fetchImpl, asked } = node({ eth_blockNumber: '0x64' });
  const result = await followBridged('http://node', {
    bridge: BRIDGE,
    cursor: 99,
    confirmations: 3,
    onBurn: async () => {},
    fetchImpl,
  });

  assert.equal(result.cursor, 99, 'the cursor does not move over ground it has not covered');
  assert.equal(asked.some((c) => c.method === 'eth_getLogs'), false);
});

/// Public nodes cap the span. Asking for everything since deployment works
/// until it does not.
test('walks a long range in chunks', async () => {
  const { fetchImpl, asked } = node({ eth_blockNumber: '0x186a0', eth_getLogs: [] });
  const result = await followBridged('http://node', {
    bridge: BRIDGE,
    cursor: 0,
    confirmations: 0,
    maxSpan: 2000,
    onBurn: async () => {},
    fetchImpl,
  });

  assert.equal(result.cursor, 2000, 'one chunk, not the whole hundred thousand');
  const [filter] = asked.find((c) => c.method === 'eth_getLogs').params;
  assert.equal(filter.toBlock, '0x7d0');
});

test('hands every burn over before moving the cursor', async () => {
  const { fetchImpl } = node({ eth_blockNumber: '0x2b15040', eth_getLogs: [REAL_LOG] });
  const seen = [];

  const result = await followBridged('http://node', {
    bridge: BRIDGE,
    cursor: 45174800,
    confirmations: 3,
    onBurn: async (burn) => seen.push(burn.stellarRecipient),
    fetchImpl,
  });

  assert.deepEqual(seen, [RECIPIENT]);
  assert.equal(result.found, 1);
});
