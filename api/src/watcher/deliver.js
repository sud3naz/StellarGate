/**
 * The last step: telling Circle's forwarder on Stellar to mint and pay out.
 *
 * Nobody does this for us. Two attested messages were left alone during the
 * testnet run to find out whether Circle's own relayer would execute the
 * forward — the standard one for fourteen minutes, the fast one for four — and
 * neither arrived. The call is permissionless and costs about 0.0075 XLM, so
 * this is a line on the watcher's list rather than a problem, but it is not
 * optional and there is no user-facing button for it either.
 *
 * The important property is that being late is free. `mint_and_forward` ends
 * in a token transfer that fails if the recipient has no USDC trustline, and a
 * failure there does **not** consume the CCTP message — so the same message
 * can be presented again once the trustline exists. That is why almost every
 * failure here is worth retrying, and why the dangerous mistake would be to
 * mark a transfer dead on the first refusal.
 */

import { Contract, TransactionBuilder, nativeToScVal, rpc } from '@stellar/stellar-sdk';

/// Circle's CctpForwarder, per network.
export const FORWARDER = {
  testnet: 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ',
  public: 'CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T',
};

/**
 * Contract error codes, read off the deployed contracts' own error enums
 * rather than guessed from the names. Soroban reports these as
 * `Error(Contract, #6908)` and nothing else — there is no text to match on,
 * which is how the first version of this function came to be wrong: it
 * searched for words like "already used" and read a consumed message as
 * something worth retrying forever.
 */
export const NONCE_ALREADY_USED = 6908;

/// Messages that can never be made to work: the hook, the format or the
/// signatures are wrong. Retrying is not the answer and neither is silence.
const MALFORMED = new Set([
  6000, 6001, 6002, 6003, 6004, // attestation signatures
  6904, 6905, 6906, 6907, // message format, domain, caller, version
  7300, 7301, 7302, 7303, 7304, 7305, 7306, 7307, 7313, // forwarder's own
]);

/// The contracts are pausable. A pause ends.
const PAUSED = 1000;

function contractErrorCode(text) {
  const match = /Error\(Contract,\s*#(\d+)\)/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * What a refusal means.
 *
 * The default is **retry**, and that is a decision rather than laziness. A
 * failed delivery does not consume the message, so a wrongly-retried transfer
 * costs a transaction fee while a wrongly-abandoned one costs the user
 * everything they sent. With that asymmetry the burden of proof belongs on
 * "give up".
 *
 * Two exceptions, in opposite directions. A consumed nonce means an earlier
 * attempt already landed and there is nothing left to do. A malformed message
 * will fail identically forever, so retrying is just a slower way of not
 * telling anyone — it needs a person, and says so.
 *
 * @dev A missing trustline was the one worth checking rather than assuming,
 * and it behaves as the design claims. Delivering into a funded account with
 * no USDC line failed at simulation with a message naming the trustline —
 * matched below, and from the token contract rather than either enum here.
 * Adding the line and presenting the *same* message again delivered in full:
 * a failure consumes nothing, so being late really does cost nothing.
 */
export function classifyFailure(error) {
  const text = String(error?.message ?? error ?? '');
  const code = contractErrorCode(text);

  if (code === NONCE_ALREADY_USED) {
    return { retryable: false, done: true, reason: 'already delivered (nonce consumed)' };
  }
  if (code !== null && MALFORMED.has(code)) {
    return {
      retryable: false,
      needsHuman: true,
      reason: `the message cannot be delivered as it stands (contract error ${code})`,
    };
  }
  if (code === PAUSED) {
    return { retryable: true, reason: 'Circle has paused the contract' };
  }
  if (/trustline|no_trust|TrustlineMissing/i.test(text)) {
    return { retryable: true, reason: 'the recipient has no USDC trustline yet' };
  }
  return { retryable: true, reason: text.slice(0, 200) || 'unknown failure' };
}

/**
 * Calls `mint_and_forward(message, attestation)`.
 *
 * @param message     Raw hex, no `0x`. From {fetchAttestation}.
 * @param attestation Raw hex, no `0x`.
 * @param signer      Keypair that pays the fee. Holds no user funds; it is
 *                    only ever out of pocket for the transaction itself.
 * @returns `{ ok: true, hash }`, or `{ ok: false, retryable, reason }`.
 */
export async function deliver({
  rpcUrl,
  networkPassphrase,
  forwarderId,
  signer,
  message,
  attestation,
  baseFee = '1000000',
  serverImpl = null,
}) {
  if (!message || !attestation) {
    throw new Error('deliver needs both the message and its attestation');
  }

  const server = serverImpl ?? new rpc.Server(rpcUrl);
  const contract = new Contract(forwarderId);

  const args = [
    nativeToScVal(Buffer.from(message, 'hex'), { type: 'bytes' }),
    nativeToScVal(Buffer.from(attestation, 'hex'), { type: 'bytes' }),
  ];

  try {
    const source = await server.getAccount(signer.publicKey());
    const built = new TransactionBuilder(source, { fee: baseFee, networkPassphrase })
      .addOperation(contract.call('mint_and_forward', ...args))
      .setTimeout(180)
      .build();

    // Simulates and fills in the resource footprint. Throws on a simulation
    // failure, which is where a missing trustline surfaces — before anything
    // has been submitted or paid for.
    const prepared = await server.prepareTransaction(built);
    prepared.sign(signer);

    const sent = await server.sendTransaction(prepared);
    if (sent.status === 'ERROR') {
      return { ok: false, ...classifyFailure(sent.errorResult ?? 'send rejected') };
    }

    const settled = await server.pollTransaction(sent.hash);
    if (settled.status !== 'SUCCESS') {
      return { ok: false, hash: sent.hash, ...classifyFailure(settled.resultXdr ?? settled.status) };
    }

    return { ok: true, hash: sent.hash };
  } catch (error) {
    return { ok: false, ...classifyFailure(error) };
  }
}
