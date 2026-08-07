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
 * make it, and a user who has no ETH cannot — so leaving it to them does not
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
 * Reads `Bridged` events out of the Soroban contract.
 *
 * There is no receipt to read on this side — a Stellar transaction does not
 * hand back logs the way an EVM one does — so a burn is only knowable through
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
  if (body.error) throw new Error(`soroban rpc: ${body.error.message}`);

  const result = body.result ?? {};
  return {
    burns: (result.events ?? []).map((event) => ({
      txHash: event.txHash,
      ledger: event.ledger,
      contractId: event.contractId,
    })),
    cursor: result.cursor ?? result.latestLedger ?? cursor,
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
export async function reverseStep(transfer, { store, attest, claim }) {
  if (transfer.deliveredAt) return { action: 'done', reason: 'already claimed' };

  const attestation = await attest(transfer.txHash);
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
