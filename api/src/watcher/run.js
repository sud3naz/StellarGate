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
import { fetchStellarBurns } from './reverse.js';
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
  ...stepDeps
}) {
  let at = cursor ?? (await latestBlock(rpc, { fetchImpl }));
  log({ event: 'started', cursor: at, bridge });

  let lastFollow = 0;
  let lastReverse = 0;
  let reverseCursor = reverse?.cursor ?? null;

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
            // It is not enough to provision one — that needs the setup XDR
            // from the browser, and the proof from `verifyPaidBurn` at the
            // moment the XLM would move.
            store.remember({ txHash: burn.txHash, recipient: burn.stellarRecipient });
            log({ event: 'burn', txHash: burn.txHash, recipient: burn.stellarRecipient });
          },
        });
        at = result.cursor;
      } catch (error) {
        // A node having a bad minute is not a reason to stop watching.
        log({ event: 'follow-failed', reason: String(error?.message ?? error) });
      }
    }

    if (reverse && now - lastReverse >= followSeconds * 1000) {
      lastReverse = now;
      try {
        const found = await fetchStellarBurns(reverse.rpcUrl, {
          contractId: reverse.contractId,
          cursor: reverseCursor,
          startLedger: reverseCursor ? null : reverse.startLedger,
          fetchImpl,
        });
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
        reverseCursor = found.cursor;
      } catch (error) {
        log({ event: 'follow-out-failed', reason: String(error?.message ?? error) });
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

  log({ event: 'stopped', cursor: at, reverseCursor });
  return { cursor: at, reverseCursor };
}
