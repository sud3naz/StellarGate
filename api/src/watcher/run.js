/**
 * The daemon: follow burns, work the queue, repeat.
 *
 * Deliberately dull. Everything that can lose money lives in {step}, {store}
 * and {verifyPaidBurn}, all of which are tested without a clock; what is left
 * here is a loop and two intervals. If this file ever needs a rule in it,
 * the rule is in the wrong place.
 *
 * The two halves run at different speeds for a reason. Following logs is one
 * cheap call and finding a burn late only delays that user, so it can be
 * leisurely. Working the queue is what turns an attested transfer into USDC,
 * and a fast transfer attests in under thirty seconds, so it runs often
 * enough not to be the slowest part of its own delivery.
 */

import { followBridged, latestBlock } from './logs.js';
import { followStellarBurns, ledgerWindow } from './reverse.js';
import { sweep } from './index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param deps Everything {step} needs, plus `rpc`, `bridge` and a `cursor`
 *        to start from. `log` is called with structured lines rather than
 *        strings, so whatever collects them can filter.
 */
export async function run({
  rpc,
  bridge,
  store,
  cursor,
  followSeconds = 12,
  sweepSeconds = 5,
  log = () => {},
  signal,
  fetchImpl = fetch,
  // The other direction, if this deployment runs it. Its cursor is Soroban's
  // own and opaque, so it is carried rather than computed.
  reverse = null,
  // Where the loop leaves proof that it is still scanning, for /health to
  // read. Optional so every existing test calls run() unchanged.
  pulse = null,
  // Where both positions are remembered across restarts. Optional so every
  // existing test calls run() unchanged, and absent means the old behaviour:
  // start at the tip and never mind what happened while we were away.
  cursors = null,
  ...stepDeps
}) {
  // Saved beats configured. `cursor` is an operator's override and it lives in
  // an env file, so preferring it would re-seed from the same block on every
  // restart and quietly undo the saving. To force a rescan, delete the file.
  const saved = cursors?.get('inbound') ?? null;
  let at = saved ?? cursor ?? (await latestBlock(rpc, { fetchImpl }));
  log({ event: 'started', cursor: at, resumed: saved !== null, bridge });

  let lastFollow = 0;
  let lastReverse = 0;

  // A ledger number, not a cursor. Soroban hands back a cursor pointing at a
  // ledger it has not finished indexing, then refuses that same cursor until
  // the chain reaches it, so carrying one between polls fails about half the
  // time. {followStellarBurns} has the measurements.
  //
  // Soroban has no "from wherever you are", so a follower with no history of
  // its own still needs somewhere to begin. Clamped to what the node keeps,
  // because a start it has forgotten is refused exactly as loudly.
  let reverseFrom = cursors?.get('outbound') ?? reverse?.startLedger ?? null;
  if (reverse) {
    const window = await ledgerWindow(reverse.rpcUrl, { fetchImpl });
    // Still clamped to the window even when resumed: a position from before a
    // long outage can be older than anything the node still holds, and asking
    // for it is refused rather than served.
    reverseFrom = Math.max(reverseFrom ?? window.latest, window.oldest);
    log({
      event: 'following-out',
      from: reverseFrom,
      resumed: cursors?.get('outbound') != null,
      contract: reverse.contractId,
    });
  }

  while (!signal?.aborted) {
    const now = Date.now();

    if (now - lastFollow >= followSeconds * 1000) {
      lastFollow = now;
      try {
        const result = await followBridged(rpc, {
          bridge,
          cursor: at,
          fetchImpl,
          onBurn: async (burn) => {
            // The log is enough to know a transfer exists and who it is for.
            // It is not enough to provision one, that needs the setup XDR
            // from the browser, and the proof from `verifyPaidBurn` at the
            // moment the XLM would move.
            store.remember({ txHash: burn.txHash, recipient: burn.stellarRecipient });
            log({ event: 'burn', txHash: burn.txHash, recipient: burn.stellarRecipient });
          },
        });
        at = result.cursor;
        // After the burns above are in the store, never before. Saving first
        // would move past a burn that was never recorded.
        cursors?.set('inbound', at);
        pulse?.scanned(at);
      } catch (error) {
        // A node having a bad minute is not a reason to stop watching.
        log({ event: 'follow-failed', reason: String(error?.message ?? error) });
        pulse?.failed(error?.message ?? error);
      }
    }

    if (reverse && now - lastReverse >= followSeconds * 1000) {
      lastReverse = now;
      try {
        const found = await followStellarBurns(reverse.rpcUrl, {
          contractId: reverse.contractId,
          fromLedger: reverseFrom,
          fetchImpl,
        });
        // Falling off the back of the retention window loses ledgers for
        // good, so it is said out loud rather than absorbed: everything
        // between where we were and where we resume was never read.
        if (found.rewound) {
          log({ event: 'follow-out-rewound', from: reverseFrom, to: found.nextLedger });
        }
        for (const burn of found.burns) {
          // The recipient is inside the event rather than beside it, and
          // nothing downstream needs it: going out there is no account to
          // build and no address of ours to check it against.
          store.remember({
            txHash: burn.txHash,
            recipient: reverse.contractId,
            direction: 'out',
          });
          log({ event: 'burn-out', txHash: burn.txHash, ledger: burn.ledger });
        }
        reverseFrom = found.nextLedger;
        cursors?.set('outbound', reverseFrom);
        // Being caught up is a completed scan, not a missed one. It is the
        // usual answer on a quiet chain and the pulse has to count it, or a
        // healthy follower with nothing to do reads as stalled.
        pulse?.scannedReverse(reverseFrom);
      } catch (error) {
        log({ event: 'follow-out-failed', reason: String(error?.message ?? error) });
        pulse?.failed(error?.message ?? error);
      }
    }

    try {
      const results = await sweep({ store, ...stepDeps });
      for (const result of results) {
        if (result.action !== 'wait') log({ event: 'step', ...result });
      }
    } catch (error) {
      log({ event: 'sweep-failed', reason: String(error?.message ?? error) });
    }

    await sleep(sweepSeconds * 1000);
  }

  log({ event: 'stopped', cursor: at, reverseLedger: reverseFrom });
  return { cursor: at, reverseLedger: reverseFrom };
}
