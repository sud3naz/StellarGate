/**
 * Asking Circle whether a burn has been signed off, and reading the answer
 * correctly when it is not.
 *
 * The naive version treats anything that is not `complete` as "wait" and
 * anything that never completes as lost. Both are wrong in ways that were
 * measured on testnet rather than guessed at:
 *
 * **`insufficient_fee` is not a failure.** A burn sent with a `maxFee` too
 * small for a fast transfer sat under that reason for twenty minutes and then
 * attested at hard finality instead — `finalityThresholdExecuted` came back
 * 2000 against the 1000 asked for — and delivered in full, with no fee at all.
 * A watcher that gives up on that reason abandons money that was going to
 * arrive. What it should do is stop expecting it in thirty seconds.
 *
 * **The wait is not one length.** Fast attests in twenty to thirty seconds.
 * Hard finality on Base Sepolia took twenty-five minutes. A poll interval
 * tuned for one is wrong for the other, and a transfer can move from the first
 * to the second while being watched.
 */

/// Circle's sandbox is testnet; the other one is not.
export const IRIS = {
  testnet: 'https://iris-api-sandbox.circle.com',
  public: 'https://iris-api.circle.com',
};

/**
 * @param api          Base URL, from {IRIS}.
 * @param sourceDomain CCTP domain the burn happened on. Base is 6.
 * @param txHash       The burn transaction.
 * @returns `null` when Circle has no record of it yet — a burn that has not
 *          been indexed is not a burn that failed.
 */
export async function fetchAttestation(api, sourceDomain, txHash, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(
    `${api}/v2/messages/${sourceDomain}?transactionHash=${txHash}`,
  );

  // Circle answers 404 for a burn it has not seen. Common in the seconds after
  // one lands, and not worth distinguishing from an empty list.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`iris: ${response.status}`);

  const body = await response.json();
  const message = body?.messages?.[0];
  if (!message) return null;

  const decoded = message.decodedMessage ?? {};
  const executed = decoded.finalityThresholdExecuted;

  return {
    status: message.status,
    ready: message.status === 'complete',
    /// Why it is taking longer than asked. `insufficient_fee` means the fast
    /// tier was refused and hard finality is being waited out instead.
    delayReason: message.delayReason ?? null,
    /// What was asked for, and what Circle actually did. They differ when a
    /// fast transfer falls back.
    finalityRequested: decoded.minFinalityThreshold ? Number(decoded.minFinalityThreshold) : null,
    finalityExecuted: executed ? Number(executed) : null,
    fellBackToStandard: Boolean(executed && Number(executed) === 2000 && message.delayReason),
    /// The two things `mint_and_forward` needs, without their `0x`, which is
    /// how the Stellar CLI and SDK want them.
    message: message.message ? message.message.slice(2) : null,
    attestation: message.attestation && message.attestation !== 'PENDING'
      ? message.attestation.slice(2)
      : null,
  };
}

/**
 * How long to wait before asking again.
 *
 * Fast should be back inside half a minute, so a short interval is cheap and
 * the transfer is quick. Once Circle has said `insufficient_fee`, the answer
 * is minutes away rather than seconds and polling hard just makes noise.
 */
export function nextPollSeconds(attestation, { elapsedSeconds = 0 } = {}) {
  if (attestation?.ready) return 0;
  if (attestation?.delayReason === 'insufficient_fee') return 60;
  // Past the fast window, this is a hard-finality wait whether it says so yet
  // or not.
  return elapsedSeconds > 90 ? 60 : 5;
}

/**
 * Whether to keep waiting at all.
 *
 * Deliberately generous: the only thing here that is genuinely lost is a burn
 * Circle refuses outright, and none has been seen. Everything else — pending,
 * an insufficient fee, an unindexed transaction — arrives eventually. Giving
 * up early means a user's USDC sits burned while nobody is watching.
 */
export function stillWorthWaiting(attestation, { elapsedSeconds }) {
  if (attestation?.ready) return false;
  // Hard finality took twenty-five minutes on testnet; an hour is that with
  // room, and past it a human should look rather than a loop keep spinning.
  return elapsedSeconds < 60 * 60;
}
