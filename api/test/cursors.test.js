import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Cursors } from '../src/watcher/cursors.js';
import { run } from '../src/watcher/run.js';
import { Store } from '../src/watcher/store.js';
import { BRIDGED_TOPIC } from '../src/watcher/burn.js';

/**
 * Remembering where the followers were.
 *
 * Without this, both directions start at the tip on every restart, so anything
 * burned while the process was down sits behind the starting point and is
 * never looked at. A deploy causes it, and a deploy is the most ordinary thing
 * that happens to this service.
 */

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cursors-'));
  return { path: join(dir, 'cursors.json'), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test('nothing saved means start wherever you would', () => {
  const cursors = new Cursors();
  assert.equal(cursors.get('inbound'), null);
});

test('a position survives a new process reading the same file', () => {
  // The whole point, and the only test here that matters on its own.
  const { path, clean } = scratch();
  try {
    new Cursors({ path }).set('inbound', 45_301_888);
    assert.equal(new Cursors({ path }).get('inbound'), 45_301_888);
  } finally {
    clean();
  }
});

test('the two directions are kept apart', () => {
  const { path, clean } = scratch();
  try {
    const cursors = new Cursors({ path });
    cursors.set('inbound', 45_301_888);
    cursors.set('outbound', 4_076_819);

    const reopened = new Cursors({ path });
    assert.equal(reopened.get('inbound'), 45_301_888);
    assert.equal(reopened.get('outbound'), 4_076_819);
  } finally {
    clean();
  }
});

test('a position never moves backwards', () => {
  // Re-reading an older block would re-deliver a burn already delivered, and
  // the store is the only thing between that and paying twice.
  const cursors = new Cursors();
  cursors.set('inbound', 100);
  assert.equal(cursors.set('inbound', 50), 100);
  assert.equal(cursors.get('inbound'), 100);
});

test('nonsense is refused rather than written', () => {
  const cursors = new Cursors();
  cursors.set('inbound', 0);
  cursors.set('inbound', -5);
  cursors.set('inbound', 1.5);
  cursors.set('inbound', NaN);
  assert.equal(cursors.get('inbound'), null);
});

test('a file that cannot be read is the same as no file', () => {
  // Refusing to boot over a damaged cache would turn a lost position into an
  // outage, which is the worse of the two.
  const { path, clean } = scratch();
  try {
    writeFileSync(path, 'this is not json');
    const cursors = new Cursors({ path });
    assert.equal(cursors.get('inbound'), null);
    cursors.set('inbound', 42);
    assert.equal(new Cursors({ path }).get('inbound'), 42, 'and it recovers on the next write');
  } finally {
    clean();
  }
});

test('a garbled entry is dropped without taking the others with it', () => {
  const { path, clean } = scratch();
  try {
    writeFileSync(path, JSON.stringify({ inbound: 'soon', outbound: 4_076_819 }));
    const cursors = new Cursors({ path });
    assert.equal(cursors.get('inbound'), null);
    assert.equal(cursors.get('outbound'), 4_076_819);
  } finally {
    clean();
  }
});

test('the file is written whole, never half a number', () => {
  const { path, clean } = scratch();
  try {
    new Cursors({ path }).set('inbound', 45_301_888);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { inbound: 45_301_888 });
  } finally {
    clean();
  }
});

// ------------------------------------------------------------------ the loop

const BRIDGE = '0x69752D7C3d1c7C919bc24e34cD440762F642FF00';

/** A node that answers a tip and no logs, recording what it was asked. */
function node(asked) {
  return async (_url, init) => {
    const call = JSON.parse(init.body);
    if (call.method === 'eth_blockNumber') return { ok: true, json: async () => ({ result: '0x2b15040' }) };
    if (call.method === 'eth_getLogs') {
      asked.push(call.params[0]);
      return { ok: true, json: async () => ({ result: [] }) };
    }
    return { ok: true, json: async () => ({ result: [] }) };
  };
}

test('the follower resumes from the saved position rather than the tip', async () => {
  const controller = new AbortController();
  const asked = [];
  const cursors = new Cursors();
  cursors.set('inbound', 45_100_000);

  const loop = run({
    rpc: 'http://node',
    bridge: BRIDGE,
    store: new Store(),
    cursors,
    followSeconds: 0,
    sweepSeconds: 0.01,
    signal: controller.signal,
    fetchImpl: node(asked),
    verifyBurn: async () => null,
    submitSetup: async () => ({ ok: true }),
    attest: async () => ({ ready: false }),
    deliver: async () => ({ ok: true }),
  });

  const started = Date.now();
  while (asked.length === 0 && Date.now() - started < 2000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  controller.abort();
  await loop;

  assert.ok(asked.length > 0, 'the node was asked something');
  // One past the saved block, because the saved block is the last one already
  // scanned. No gap and no overlap, which is the whole contract.
  assert.equal(
    Number(asked[0].fromBlock),
    45_100_001,
    'resumed one past where it left off, rather than at the tip',
  );
});

test('a saved position beats the configured one, so saving is not undone every boot', async () => {
  // BRIDGE_CURSOR lives in an env file. Preferring it would re-seed from the
  // same block on every restart and quietly defeat the point of saving.
  const controller = new AbortController();
  const asked = [];
  const cursors = new Cursors();
  cursors.set('inbound', 45_100_000);

  const loop = run({
    rpc: 'http://node',
    bridge: BRIDGE,
    store: new Store(),
    cursors,
    cursor: 44_000_000,
    followSeconds: 0,
    sweepSeconds: 0.01,
    signal: controller.signal,
    fetchImpl: node(asked),
    verifyBurn: async () => null,
    submitSetup: async () => ({ ok: true }),
    attest: async () => ({ ready: false }),
    deliver: async () => ({ ok: true }),
  });

  const started = Date.now();
  while (asked.length === 0 && Date.now() - started < 2000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  controller.abort();
  await loop;

  assert.equal(Number(asked[0].fromBlock), 45_100_001, 'the saved position, not the configured one');
});

test('the position is saved as the follower moves', async () => {
  const controller = new AbortController();
  const asked = [];
  const cursors = new Cursors();

  const loop = run({
    rpc: 'http://node',
    bridge: BRIDGE,
    store: new Store(),
    cursors,
    cursor: 45_174_800,
    followSeconds: 0,
    sweepSeconds: 0.01,
    signal: controller.signal,
    fetchImpl: node(asked),
    verifyBurn: async () => null,
    submitSetup: async () => ({ ok: true }),
    attest: async () => ({ ready: false }),
    deliver: async () => ({ ok: true }),
  });

  const started = Date.now();
  while (cursors.get('inbound') === null && Date.now() - started < 2000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  controller.abort();
  await loop;

  assert.ok(cursors.get('inbound') > 0, 'a position was written without anyone asking');
});
