import test from 'node:test';
import assert from 'node:assert/strict';

import { followStellarBurns, NotIndexedYet } from '../src/watcher/reverse.js';

/**
 * The outbound follower, against the way the node actually behaves.
 *
 * All of this exists because of one measurement. Asked for events from a
 * ledger, soroban-testnet returns a cursor pointing four or five ledgers past
 * the `latestLedger` in the same response, and then refuses that cursor with
 * `startLedger must be within the ledger range: OLDEST - LATEST` until the
 * chain catches up. The old follower carried that cursor between polls, so
 * roughly every other poll was rejected: 887 refusals in a day, each one
 * logged as a failure, none of them a failure at all.
 *
 * The tests below encode the node's real shape rather than a convenient one.
 */

const CONTRACT = 'CCWMXUFXXYL6HEL4BYXRPLUXPGI2DEYEOP7TZX7EXWZBOM7WAWWDMWHR';
const TX = 'cf745fd80751449d3f81fa91930dfb2f6f828e504d4d6dd06c7321c576dc8737';

/** Records every request so a test can assert on what was actually sent. */
function node(replies) {
  const asked = [];
  let i = 0;
  const fetchImpl = async (_url, init) => {
    const params = JSON.parse(init.body).params;
    asked.push(params);
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (reply.error) {
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, error: reply.error }) };
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: reply }) };
  };
  return { fetchImpl, asked };
}

const outOfRange = (oldest, latest) => ({
  error: { code: -32600, message: `startLedger must be within the ledger range: ${oldest} - ${latest}` },
});

test('the ledger to resume from is tracked, not the cursor the node hands back', async () => {
  // The shape that caused the outage: a cursor pointing past latestLedger.
  const { fetchImpl, asked } = node([
    { events: [], cursor: '0017509018297696255-4294967295', latestLedger: 4076631, oldestLedger: 3955672 },
  ]);

  const first = await followStellarBurns('http://rpc', {
    contractId: CONTRACT, fromLedger: 4076631, fetchImpl,
  });

  assert.equal(asked[0].startLedger, 4076631);
  // One past what the node admits to having indexed, and emphatically not the
  // cursor, whose ledger is 4076635 and does not exist yet.
  assert.equal(first.nextLedger, 4076632);
  assert.equal(first.caughtUp, true);
});

test('a second poll asks by ledger again, never by the returned cursor', async () => {
  const { fetchImpl, asked } = node([
    { events: [], cursor: '0017509018297696255-4294967295', latestLedger: 4076631, oldestLedger: 3955672 },
    { events: [], cursor: '0017509044067500031-4294967295', latestLedger: 4076640, oldestLedger: 3955681 },
  ]);

  const first = await followStellarBurns('http://rpc', { contractId: CONTRACT, fromLedger: 4076631, fetchImpl });
  await followStellarBurns('http://rpc', { contractId: CONTRACT, fromLedger: first.nextLedger, fetchImpl });

  assert.equal(asked[1].startLedger, 4076632, 'resumed by ledger');
  assert.equal(asked[1].pagination?.cursor, undefined, 'the cursor must not travel between polls');
});

test('being ahead of the indexed tip is caught up, not a failure', async () => {
  // The node refusing because we are already at its edge. This is the answer
  // it gives on a quiet chain, and calling it an error is what produced 887
  // identical log lines that hid everything else.
  const { fetchImpl } = node([outOfRange(3955672, 4076631)]);

  const result = await followStellarBurns('http://rpc', {
    contractId: CONTRACT, fromLedger: 4076632, fetchImpl,
  });

  assert.equal(result.caughtUp, true);
  assert.equal(result.nextLedger, 4076632, 'stays put, so nothing is skipped');
  assert.equal(result.burns.length, 0);
});

test('falling behind the retention window rewinds, and says so', async () => {
  // Different problem, opposite direction: these ledgers are gone for good.
  // Waiting would mean asking for a forgotten ledger forever.
  const { fetchImpl } = node([outOfRange(3955672, 4076631)]);

  const result = await followStellarBurns('http://rpc', {
    contractId: CONTRACT, fromLedger: 3_000_000, fetchImpl,
  });

  assert.equal(result.rewound, true);
  assert.equal(result.nextLedger, 3955672, 'resumes at the oldest the node still holds');
  assert.equal(result.caughtUp, false);
});

test('burns are returned and the next ledger clears the last of them', async () => {
  const { fetchImpl } = node([
    {
      events: [
        { txHash: TX, ledger: 4076500, contractId: CONTRACT },
        { txHash: TX, ledger: 4076502, contractId: CONTRACT },
      ],
      cursor: 'whatever',
      latestLedger: 4076631,
    },
  ]);

  const result = await followStellarBurns('http://rpc', {
    contractId: CONTRACT, fromLedger: 4076400, fetchImpl,
  });

  assert.equal(result.burns.length, 2);
  assert.equal(result.nextLedger, 4076503, 'one past the newest burn, so none is read twice');
  assert.equal(result.caughtUp, false);
});

test('a full page is followed by cursor, which is what the cursor is for', async () => {
  const page = (n, ledger) => ({
    events: Array.from({ length: n }, () => ({ txHash: TX, ledger, contractId: CONTRACT })),
    cursor: `cursor-at-${ledger}`,
    latestLedger: 4076631,
  });
  const { fetchImpl, asked } = node([page(2, 4076500), page(1, 4076501)]);

  const result = await followStellarBurns('http://rpc', {
    contractId: CONTRACT, fromLedger: 4076400, limit: 2, fetchImpl,
  });

  assert.equal(asked[0].startLedger, 4076400);
  assert.equal(asked[1].pagination.cursor, 'cursor-at-4076500', 'paging within one range is its job');
  assert.equal(asked[1].startLedger, undefined, 'the node refuses both together');
  assert.equal(result.burns.length, 3, 'both pages kept');
  assert.equal(result.nextLedger, 4076502);
});

test('paging that runs into the tip keeps what it read', async () => {
  const { fetchImpl } = node([
    {
      events: [{ txHash: TX, ledger: 4076500, contractId: CONTRACT }],
      cursor: 'c1',
      latestLedger: 4076631,
    },
    outOfRange(3955672, 4076631),
  ]);

  const result = await followStellarBurns('http://rpc', {
    contractId: CONTRACT, fromLedger: 4076400, limit: 1, fetchImpl,
  });

  assert.equal(result.burns.length, 1, 'the burn already read is not thrown away');
  assert.equal(result.nextLedger, 4076501);
});

test('the ledger never goes backwards, whatever the node says', async () => {
  // A pool behind a load balancer can answer from a node that is behind.
  // Rewinding would replay burns already delivered.
  const { fetchImpl } = node([{ events: [], cursor: 'c', latestLedger: 4_000_000 }]);

  const result = await followStellarBurns('http://rpc', {
    contractId: CONTRACT, fromLedger: 4_076_000, fetchImpl,
  });

  assert.equal(result.nextLedger, 4_076_000);
});

test('a ledger to start from is required, and the node is not asked without one', async () => {
  await assert.rejects(
    () =>
      followStellarBurns('http://rpc', {
        contractId: CONTRACT,
        fetchImpl: async () => assert.fail('the node should never have been asked'),
      }),
    /ledger to start from/,
  );
});

test('an error that is not about the range is still an error', async () => {
  const { fetchImpl } = node([{ error: { code: -32603, message: 'internal error' } }]);

  await assert.rejects(
    () => followStellarBurns('http://rpc', { contractId: CONTRACT, fromLedger: 100, fetchImpl }),
    (e) => !(e instanceof NotIndexedYet) && /internal error/.test(e.message),
  );
});

test('the refusal carries the bounds the node reported', async () => {
  const { fetchImpl } = node([outOfRange(111, 222)]);
  const result = await followStellarBurns('http://rpc', {
    contractId: CONTRACT, fromLedger: 223, fetchImpl,
  });
  assert.equal(result.latestLedger, 222, 'so a caller can see how far the node has got');
});
