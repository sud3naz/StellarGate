/**
 * Proof that a burn happened, and that it paid for what is about to be spent.
 *
 * This exists because the guard that was supposed to prevent the mistake was
 * not on the path. `flow.js` refuses to provision a transfer that has not
 * paid, but it refuses in `advance()`, and `submit()` is reachable without
 * ever calling it. During the testnet run a burn failed silently, the setup
 * went in regardless, and three XLM left for an activation nobody had bought.
 *
 * So the check moves to where the money leaves. Whoever spends has to look
 * rather than be told: a boolean can be wrong about a burn, a receipt cannot.
 * {verifyPaidBurn} returns a value that can only be obtained by reading the
 * source chain, and the spending path asks for that value rather than for a
 * flag.
 *
 * Three things are checked, and each one is a way the naive version loses
 * money:
 *
 *   1. **The transaction succeeded.** A reverted burn still has a receipt.
 *   2. **The log came from our contract.** `Bridged` is just an event
 *      signature; anyone can deploy something that emits it. Filtering by
 *      address is the whole security boundary here.
 *   3. **It names this recipient.** Otherwise a single paid burn can be
 *      replayed against every address somebody cares to ask about.
 *
 * Replay of the same burn against the *same* address is not this module's
 * job, that needs a store, and it belongs there.
 */

/// keccak256("Bridged(address,string,uint256,uint256,uint256,uint8,bool)")
export const BRIDGED_TOPIC = '0xe7324a1932477e87d8e03d49f6fa53f09838cd8ea4c3562cf9cda447db6266f6';

export class UnpaidBurn extends Error {}

/**
 * Reads a 32-byte word out of ABI-encoded data, by index.
 * @param hex `0x`-prefixed encoded data.
 */
function word(hex, index) {
  const start = 2 + index * 64;
  const slice = hex.slice(start, start + 64);
  if (slice.length !== 64) throw new UnpaidBurn('the Bridged log is truncated');
  return BigInt(`0x${slice}`);
}

/**
 * Decodes a `Bridged` log.
 *
 * @dev The recipient is a `string`, so it is stored out of line: the first
 * word is a byte offset to a length and then the text. Reading it as a fixed
 * slot would silently return the offset instead, which is the kind of bug that
 * only shows up once an address is long enough to matter.
 */
export function decodeBridged(log) {
  if (log.topics?.[0]?.toLowerCase() !== BRIDGED_TOPIC) {
    throw new UnpaidBurn('not a Bridged log');
  }

  const data = log.data;
  const offset = Number(word(data, 0));
  if (offset % 32 !== 0) throw new UnpaidBurn('the Bridged log is malformed');

  const lengthIndex = offset / 32;
  const length = Number(word(data, lengthIndex));
  const textStart = 2 + (lengthIndex + 1) * 64;
  const text = data.slice(textStart, textStart + length * 2);
  if (text.length !== length * 2) throw new UnpaidBurn('the recipient is truncated');

  return {
    user: `0x${log.topics[1].slice(26)}`,
    stellarRecipient: Buffer.from(text, 'hex').toString('utf8'),
    gross: word(data, 1),
    net: word(data, 2),
    fee: word(data, 3),
    recipientVersion: Number(word(data, 4)),
    activate: word(data, 5) === 1n,
  };
}

async function receipt(rpc, txHash, fetchImpl) {
  const response = await fetchImpl(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    }),
  });
  if (!response.ok) throw new Error(`rpc: ${response.status}`);

  const body = await response.json();
  if (body.error) throw new Error(`rpc: ${body.error.message}`);
  // Null means the node has not seen it yet. Not a failure and not a success;
  // treating it as either is how a watcher either gives up early or pays out
  // for a transaction that never landed.
  return body.result ?? null;
}

/**
 * What the spending path has to hold before any XLM moves.
 *
 * @param rpc               Source-chain JSON-RPC endpoint.
 * @param txHash            The burn transaction.
 * @param bridge            Our contract's address. A `Bridged` log from
 *                          anywhere else is somebody else's event.
 * @param expectedRecipient The Stellar address this transfer is for.
 * @returns The decoded burn, or `null` while the receipt is still pending.
 * @throws  {UnpaidBurn} when the burn cannot pay for this transfer.
 */
export async function verifyPaidBurn(
  rpc,
  txHash,
  { bridge, expectedRecipient, fetchImpl = fetch } = {},
) {
  if (!bridge) throw new Error('verifyPaidBurn needs the bridge address');
  if (!expectedRecipient) throw new Error('verifyPaidBurn needs the expected recipient');

  const result = await receipt(rpc, txHash, fetchImpl);
  if (result === null) return null;

  if (BigInt(result.status) !== 1n) {
    throw new UnpaidBurn(`burn ${txHash} reverted`);
  }

  const log = (result.logs || []).find(
    (l) =>
      l.address?.toLowerCase() === bridge.toLowerCase() &&
      l.topics?.[0]?.toLowerCase() === BRIDGED_TOPIC,
  );
  if (!log) throw new UnpaidBurn(`no Bridged log from ${bridge} in ${txHash}`);

  const bridged = decodeBridged(log);

  if (bridged.stellarRecipient !== expectedRecipient) {
    throw new UnpaidBurn(
      `burn ${txHash} paid for ${bridged.stellarRecipient}, not ${expectedRecipient}`,
    );
  }

  return { txHash, ...bridged };
}

/**
 * The gate itself, for the two operations that spend our XLM outright.
 *
 * Kept separate from {verifyPaidBurn} because the questions are different: one
 * asks whether a burn happened, this asks whether it bought this particular
 * thing. Adding a trustline to an account that can pay its own reserve costs a
 * transaction fee and nothing else, so it is deliberately not gated here, * charging for it would be charging a user who never owed anything.
 */
export function assertPaidForActivation(proof) {
  if (!proof?.txHash) {
    throw new UnpaidBurn('refusing to spend XLM without a verified burn');
  }
  if (!proof.activate) {
    throw new UnpaidBurn(`burn ${proof.txHash} did not pay for an activation`);
  }
  return proof;
}
