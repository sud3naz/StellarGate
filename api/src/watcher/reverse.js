/**
 * The other direction's delivery: claiming a Stellar burn on the EVM side.
 *
 * Shorter than the way in, because there is nothing to build at the far end.
 * An EVM address exists whether anyone has heard of it or not, so there is no
 * account to buy, no trustline to add, and no setup for anybody to sign. Read
 * the burn, wait for Circle, call `receiveMessage`.
 *
 * We make that call rather than the user, and that is not the same decision as
 * paying their gas. `receiveMessage` is permissionless but somebody has to
 * make it, and a user who has no ETH cannot, so leaving it to them does not
 * mean they arrive without gas money, it means they do not arrive at all. What
 * they are left with is the thing that was decided: USDC on Base and nothing
 * to move it with.
 */

import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, base } from 'viem/chains';

/// Circle's MessageTransmitterV2, the same address on every EVM chain.
export const MESSAGE_TRANSMITTER = {
  testnet: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
  public: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
};

const ABI = parseAbi([
  'function receiveMessage(bytes message, bytes attestation) external returns (bool)',
]);

/// Stellar's CCTP domain, which is where these burns come from.
export const STELLAR_DOMAIN = 27;

/**
 * What a refusal from the transmitter means.
 *
 * The same asymmetry as the Stellar side sets the default: a message that has
 * already been used is finished, and everything else is worth another go,
 * because a delivery that fails does not consume it.
 */
export function classifyClaimFailure(error) {
  const text = String(error?.shortMessage ?? error?.message ?? error ?? '');

  if (/nonce already used|already been used|used nonce/i.test(text)) {
    return { retryable: false, done: true, reason: 'already claimed' };
  }
  if (/invalid attestation|invalid signature|invalid message/i.test(text)) {
    return {
      retryable: false,
      needsHuman: true,
      reason: `the transmitter will not accept this message: ${text.slice(0, 160)}`,
    };
  }
  return { retryable: true, reason: text.slice(0, 200) || 'unknown failure' };
}

/**
 * How much of the chain this node still has.
 *
 * Soroban keeps a window and forgets behind it, so both ends matter. `latest`
 * is where a follower with no history of its own starts; `oldest` is the line
 * under which a remembered starting point has become a request the node will
 * refuse.
 */
/**
 * The node refusing a ledger it has not indexed, or has already forgotten.
 *
 * Its own words are `startLedger must be within the ledger range: A - B`, and
 * it says that whether the request named a startLedger or a cursor, which is
 * part of why this took so long to read correctly. The bounds are carried
 * along because they are the node telling us exactly where it can serve from,
 * which is more useful than a string to match on later.
 */
export class NotIndexedYet extends Error {
  constructor(message, { oldest, latest }) {
    super(`soroban rpc: ${message}`);
    this.name = 'NotIndexedYet';
    this.oldest = oldest;
    this.latest = latest;
  }
}

const NOT_INDEXED = /ledger range:\s*(\d+)\s*-\s*(\d+)/;

export async function ledgerWindow(rpcUrl, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
  });
  if (!response.ok) throw new Error(`soroban rpc: ${response.status}`);

  const body = await response.json();
  if (body.error) throw new Error(`soroban rpc: ${body.error.message}`);

  return { latest: body.result.latestLedger, oldest: body.result.oldestLedger };
}

/**
 * Reads `Bridged` events out of the Soroban contract.
 *
 * There is no receipt to read on this side, a Stellar transaction does not
 * hand back logs the way an EVM one does, so a burn is only knowable through
 * what the contract chose to say about it. That is why the event carries the
 * amounts rather than only a reference to them.
 *
 * @param cursor Soroban's own paging cursor, or `null` to start from
 *        `startLedger`. It is opaque and must be stored, not reconstructed.
 */
export async function fetchStellarBurns(
  rpcUrl,
  { contractId, cursor = null, startLedger = null, limit = 100, fetchImpl = fetch } = {},
) {
  if (!contractId) throw new Error('fetchStellarBurns needs the contract id');
  if (!cursor && !startLedger) {
    // Refused here rather than by the node, because the node's answer is
    // "startLedger must be positive" and the caller's mistake was not passing
    // one at all, a difference worth a sentence when this is being read out
    // of a log at four in the morning.
    throw new Error('fetchStellarBurns needs a cursor or a ledger to start from');
  }

  const params = {
    filters: [{ type: 'contract', contractIds: [contractId] }],
    pagination: { limit },
  };
  if (cursor) params.pagination.cursor = cursor;
  else if (startLedger) params.startLedger = startLedger;

  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getEvents', params }),
  });
  if (!response.ok) throw new Error(`soroban rpc: ${response.status}`);

  const body = await response.json();
  if (body.error) {
    const range = NOT_INDEXED.exec(body.error.message);
    if (range) {
      throw new NotIndexedYet(body.error.message, {
        oldest: Number(range[1]),
        latest: Number(range[2]),
      });
    }
    throw new Error(`soroban rpc: ${body.error.message}`);
  }

  const result = body.result ?? {};
  const burns = (result.events ?? []).map((event) => ({
    txHash: event.txHash,
    ledger: event.ledger,
    contractId: event.contractId,
  }));

  return {
    burns,
    // Kept because paging within one result set is what it is for, and that
    // is still needed when a busy range holds more events than `limit`.
    cursor: result.cursor,
    // What to ask for next time, and the reason this function grew a second
    // answer. See {followStellarBurns}: the node's own `latestLedger` is the
    // furthest it admits to having indexed, so one past it is the first thing
    // it could not have shown us yet. The cursor is not that number and using
    // it as though it were is what broke.
    latestLedger: result.latestLedger ?? null,
    nextLedger: burns.length
      ? Math.max(...burns.map((b) => b.ledger)) + 1
      : (result.latestLedger ?? 0) + 1,
  };
}

/**
 * Follows the contract from a ledger, paging through whatever is there.
 *
 * The cursor is for walking one result set, not for holding a place between
 * polls, and the difference cost 887 refused requests in a day before anyone
 * looked. Measured against the live testnet node: ask from a ledger, and the
 * cursor that comes back points at a ledger the node has not finished
 * indexing, four or five ahead of the `latestLedger` in the very same
 * response. Send it back and the answer is
 * `startLedger must be within the ledger range: OLDEST - LATEST`, because the
 * place it names does not exist yet. Wait for the chain to reach it and the
 * same cursor is suddenly fine, which is why the follower recovered every
 * time and failed again every time.
 *
 * So the ledger is tracked here rather than delegated to a token the node
 * will not honour. `latestLedger` is the node's own word for how far it has
 * indexed, one past it is the first ledger it could be hiding, and asking for
 * that is either "here is what happened" or "not yet". Both are ordinary.
 *
 * @returns {{burns, nextLedger, caughtUp, latestLedger}} `caughtUp` when the
 *          node has nothing past where we already are. That is a normal
 *          answer, not a failure, and reporting it as one is what buried a
 *          real fault under 887 identical lines.
 */
export async function followStellarBurns(
  rpcUrl,
  { contractId, fromLedger, limit = 100, maxPages = 20, fetchImpl = fetch } = {},
) {
  if (!Number.isInteger(fromLedger) || fromLedger < 1) {
    throw new Error('followStellarBurns needs a ledger to start from');
  }

  const burns = [];
  let page;
  try {
    page = await fetchStellarBurns(rpcUrl, { contractId, startLedger: fromLedger, limit, fetchImpl });
  } catch (error) {
    if (error instanceof NotIndexedYet) {
      // Behind the retention window is a different problem from ahead of the
      // tip, and only one of them is waiting. Falling off the back means the
      // ledgers we wanted are gone for good, so the honest move is to resume
      // at the oldest the node still holds and say so, rather than asking for
      // a forgotten ledger forever.
      if (fromLedger < error.oldest) {
        return { burns: [], nextLedger: error.oldest, caughtUp: false, latestLedger: error.latest, rewound: true };
      }
      return { burns: [], nextLedger: fromLedger, caughtUp: true, latestLedger: error.latest };
    }
    throw error;
  }

  burns.push(...page.burns);

  // A full page means the range held at least as many events as we asked for,
  // so there may be more of them behind the cursor. This is the one place the
  // cursor belongs.
  let pages = 1;
  while (page.burns.length >= limit && page.cursor && pages < maxPages) {
    try {
      page = await fetchStellarBurns(rpcUrl, { contractId, cursor: page.cursor, limit, fetchImpl });
    } catch (error) {
      // Paging ran into the tip. Keep what was read and resume from it; the
      // rest is still there and the next poll will reach it.
      if (error instanceof NotIndexedYet) break;
      throw error;
    }
    burns.push(...page.burns);
    pages += 1;
  }

  const nextLedger = burns.length
    ? Math.max(...burns.map((b) => b.ledger)) + 1
    : (page.latestLedger ?? fromLedger - 1) + 1;

  return {
    burns,
    // Never go backwards. A node that answers with an older `latestLedger`
    // than the last one, which load balancers in front of a pool do, would
    // otherwise replay ledgers already delivered.
    nextLedger: Math.max(nextLedger, fromLedger),
    caughtUp: burns.length === 0,
    latestLedger: page.latestLedger,
  };
}

/**
 * Claims a burn on the EVM side.
 *
 * @returns `{ ok: true, hash }`, or `{ ok: false, retryable, reason }`.
 */
export async function claimOnEvm({
  rpcUrl,
  privateKey,
  transmitter,
  message,
  attestation,
  testnet = true,
  clients = null,
}) {
  if (!message || !attestation) {
    throw new Error('claiming needs both the message and its attestation');
  }

  try {
    const chain = testnet ? baseSepolia : base;
    const account = privateKeyToAccount(privateKey);
    const wallet =
      clients?.wallet ?? createWalletClient({ account, chain, transport: http(rpcUrl) });
    const publicClient =
      clients?.public ?? createPublicClient({ chain, transport: http(rpcUrl) });

    // Simulated first, so a message the transmitter will not take fails here
    // rather than as a reverted transaction somebody has paid for.
    const { request } = await publicClient.simulateContract({
      account,
      address: transmitter,
      abi: ABI,
      functionName: 'receiveMessage',
      args: [message, attestation],
    });

    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status !== 'success') {
      return { ok: false, hash, ...classifyClaimFailure('the claim reverted') };
    }
    return { ok: true, hash };
  } catch (error) {
    return { ok: false, ...classifyClaimFailure(error) };
  }
}

/**
 * Moves one Stellar-side transfer as far as it can go.
 *
 * The mirror of {step}, and missing its middle: there is no provisioning here,
 * so it is only ever wait-for-Circle then claim.
 */
export async function reverseStep(transfer, { store, attestOut, claim }) {
  if (transfer.deliveredAt) return { action: 'done', reason: 'already claimed' };

  // Deliberately not the same `attest` the inbound step uses. Circle files
  // these under Stellar's domain, and asking the wrong one returns nothing
  // for a burn that is sitting there attested.
  const attestation = await attestOut(transfer.txHash);
  if (!attestation?.ready) {
    return {
      action: 'wait',
      reason: attestation?.delayReason
        ? `waiting on Circle (${attestation.delayReason})`
        : 'waiting on Circle',
    };
  }

  // The EVM side wants `0x`; the Stellar side wanted it stripped.
  const claimed = await claim(`0x${attestation.message}`, `0x${attestation.attestation}`);

  if (claimed.done) {
    store.markDelivered(transfer.txHash, claimed.hash ?? null);
    return { action: 'done', reason: 'already claimed' };
  }
  if (!claimed.ok) {
    return { action: 'retry-claim', reason: claimed.reason };
  }

  store.markDelivered(transfer.txHash, claimed.hash);
  return { action: 'claimed', hash: claimed.hash };
}
