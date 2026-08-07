/**
 * Following `Bridged` on the source chain.
 *
 * The watcher needs to know a burn happened without being told, because the
 * browser that made it may never come back — a tab closed between the burn and
 * the confirmation still leaves USDC that has to arrive. So the log is the
 * source of truth and the frontend's message is only ever an accelerator.
 *
 * Two things this is careful about:
 *
 * **Reorgs.** A log read at the chain tip can be unwritten. Nothing here
 * spends on a log alone — `verifyPaidBurn` re-reads the receipt when the
 * transfer is actually worked, and Circle will not attest an unfinalised burn
 * anyway — but a cursor that runs ahead of a reorg silently skips transfers,
 * which is worse than being slow. So it stays a few blocks behind the tip.
 *
 * **Range limits.** Public RPCs cap `eth_getLogs` spans. Asking for everything
 * since deployment in one call works until it does not, so the range is walked
 * in chunks and the cursor only moves over ground actually covered.
 */

import { BRIDGED_TOPIC, decodeBridged } from './burn.js';

async function rpcCall(rpc, method, params, fetchImpl) {
  const response = await fetchImpl(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`rpc ${method}: ${response.status}`);

  const body = await response.json();
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message}`);
  return body.result;
}

export async function latestBlock(rpc, { fetchImpl = fetch } = {}) {
  return Number(await rpcCall(rpc, 'eth_blockNumber', [], fetchImpl));
}

/**
 * Reads `Bridged` logs in a range.
 *
 * @returns One entry per burn, carrying the decoded event and where it was
 *          found — the block number matters for the cursor, the transaction
 *          hash is what everything downstream is keyed on.
 */
export async function fetchBridgedLogs(
  rpc,
  { bridge, fromBlock, toBlock, fetchImpl = fetch } = {},
) {
  if (!bridge) throw new Error('fetchBridgedLogs needs the bridge address');

  const logs = await rpcCall(
    rpc,
    'eth_getLogs',
    [
      {
        address: bridge,
        topics: [BRIDGED_TOPIC],
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
      },
    ],
    fetchImpl,
  );

  return logs.map((log) => ({
    txHash: log.transactionHash,
    blockNumber: Number(log.blockNumber),
    ...decodeBridged(log),
  }));
}

/**
 * One pass of the follower: read what is new, hand it over, move the cursor.
 *
 * @param cursor          Last block already covered.
 * @param confirmations   How far behind the tip to stay. Cheap insurance: a
 *                        cursor that outruns a reorg loses transfers, and
 *                        being a few seconds late costs nothing.
 * @param maxSpan         Largest range to ask for in one call.
 * @param onBurn          Called once per burn found.
 * @returns The new cursor, which is only ever ground actually covered.
 */
export async function followBridged(
  rpc,
  { bridge, cursor, confirmations = 3, maxSpan = 2000, onBurn, fetchImpl = fetch },
) {
  const tip = await latestBlock(rpc, { fetchImpl });
  const safeTip = tip - confirmations;

  // Nothing settled enough to look at yet.
  if (safeTip <= cursor) return { cursor, found: 0, tip };

  const toBlock = Math.min(safeTip, cursor + maxSpan);
  const burns = await fetchBridgedLogs(rpc, {
    bridge,
    fromBlock: cursor + 1,
    toBlock,
    fetchImpl,
  });

  for (const burn of burns) await onBurn(burn);

  return { cursor: toBlock, found: burns.length, tip };
}
