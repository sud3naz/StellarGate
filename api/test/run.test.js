import test from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../src/watcher/run.js';
import { Store } from '../src/watcher/store.js';
import { BRIDGED_TOPIC } from '../src/watcher/burn.js';

const BRIDGE = '0x69752D7C3d1c7C919bc24e34cD440762F642FF00';
const RECIPIENT = 'GAFKBZTURNATMAL6KBLKBOPBRF2WZ4DKPMO6MIAUFIXVQU5EH7CHOZ5Z';
const TX = '0xaf406107764bab3b9e7d12142a1b67eefd9a24898f549ff404ff059cc9b00ec8';

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

function node({ logs = [], tip = '0x2b15040' } = {}) {
  let served = false;
  return async (_url, init) => {
    const call = JSON.parse(init.body);
    if (call.method === 'eth_blockNumber') {
      return { ok: true, json: async () => ({ result: tip }) };
    }
    // Serve the burns once, so the test does not re-find them forever.
    const result = served ? [] : logs;
    served = true;
    return { ok: true, json: async () => ({ result }) };
  };
}

/** Runs the daemon until `until()` is true, then aborts it. */
async function until(check, controller, timeoutMs = 2000) {
  const started = Date.now();
  while (!check() && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
  }
  controller.abort();
}

test('a burn found in a log becomes work, then a delivery', async () => {
  const store = new Store();
  const controller = new AbortController();
  const events = [];

  const loop = run({
    rpc: 'http://node',
    bridge: BRIDGE,
    store,
    cursor: 45174800,
    followSeconds: 0,
    sweepSeconds: 0.01,
    signal: controller.signal,
    log: (line) => events.push(line),
    fetchImpl: node({ logs: [REAL_LOG] }),
    verifyBurn: async () => ({ txHash: TX, stellarRecipient: RECIPIENT, activate: true }),
    submitSetup: async () => ({ ok: true }),
    attest: async () => ({ ready: true, message: 'de', attestation: 'ad' }),
    deliver: async () => ({ ok: true, hash: 'stellar-hash' }),
  });

  await until(() => store.get(TX)?.deliveredAt, controller);
  await loop;

  assert.equal(store.get(TX).recipient, RECIPIENT, 'the log alone was enough to know about it');
  assert.equal(store.get(TX).deliveredAt.stellarTxHash, 'stellar-hash');
  assert.ok(events.some((e) => e.event === 'burn'));
  assert.ok(events.some((e) => e.event === 'step' && e.action === 'delivered'));
});

/**
 * A log is enough to know a transfer exists. It is not enough to provision
 * one — that needs the user's signature, which only the browser has.
 */
test('a burn without its setup is remembered but not provisioned', async () => {
  const store = new Store();
  const controller = new AbortController();
  let setups = 0;

  const loop = run({
    rpc: 'http://node',
    bridge: BRIDGE,
    store,
    cursor: 45174800,
    followSeconds: 0,
    sweepSeconds: 0.01,
    signal: controller.signal,
    fetchImpl: node({ logs: [REAL_LOG] }),
    verifyBurn: async () => ({ txHash: TX, stellarRecipient: RECIPIENT, activate: true }),
    submitSetup: async () => {
      setups += 1;
      return { ok: true };
    },
    attest: async () => ({ ready: false }),
    deliver: async () => ({ ok: true, hash: 'x' }),
  });

  await until(() => store.get(TX), controller, 500);
  await loop;

  assert.equal(setups, 0, 'nothing to submit, and nothing invented');
  assert.equal(store.get(TX).provisioned, false);
});

/// A node having a bad minute is not a reason to stop watching.
test('a failing node does not stop the loop', async () => {
  const store = new Store();
  const controller = new AbortController();
  const events = [];

  const loop = run({
    rpc: 'http://node',
    bridge: BRIDGE,
    store,
    cursor: 1,
    followSeconds: 0,
    sweepSeconds: 0.01,
    signal: controller.signal,
    log: (line) => events.push(line),
    fetchImpl: async () => {
      throw new Error('node is down');
    },
    verifyBurn: async () => null,
    submitSetup: async () => ({ ok: true }),
    attest: async () => ({ ready: false }),
    deliver: async () => ({ ok: true }),
  });

  await until(() => events.some((e) => e.event === 'follow-failed'), controller);
  await loop;

  assert.ok(events.some((e) => e.event === 'follow-failed'));
  assert.ok(events.some((e) => e.event === 'stopped'), 'and it stops cleanly when asked');
});

test('it starts from the tip when given no cursor', async () => {
  const store = new Store();
  const controller = new AbortController();
  const events = [];

  const loop = run({
    rpc: 'http://node',
    bridge: BRIDGE,
    store,
    followSeconds: 100,
    sweepSeconds: 0.01,
    signal: controller.signal,
    log: (line) => events.push(line),
    fetchImpl: node(),
    verifyBurn: async () => null,
    submitSetup: async () => ({ ok: true }),
    attest: async () => ({ ready: false }),
    deliver: async () => ({ ok: true }),
  });

  await until(() => events.some((e) => e.event === 'started'), controller);
  await loop;

  const started = events.find((e) => e.event === 'started');
  assert.equal(started.cursor, 45174848, 'no cursor means from here on, not from genesis');
});
