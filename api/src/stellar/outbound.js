/**
 * Building the outbound burn for the user to sign.
 *
 * The same reason as the inbound setup: a browser cannot know a sequence
 * number, and a Soroban invocation needs its resource footprint simulated
 * before it can be submitted. So the server builds it and the user signs it.
 *
 * The difference is who pays. Going out, the user is the source of their own
 * transaction, they hold USDC on Stellar, so they hold XLM for the reserve
 * that lets them hold it, and nothing of ours is at stake. There is no
 * funder signature waiting on the far side of a burn, because the burn is the
 * thing being signed.
 */

import { Contract, TransactionBuilder, nativeToScVal, rpc, Address } from '@stellar/stellar-sdk';

/** The twenty raw bytes of an EVM address, refusing anything else. */
export function evmAddressBytes(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error('that is not an address on an EVM chain');
  }
  if (/^0x0{40}$/i.test(address)) {
    // The contract refuses this too. Catching it here means the user is told
    // before a wallet opens rather than by a reverted simulation.
    throw new Error('that address is a hole; nothing comes back out of it');
  }
  return Buffer.from(address.slice(2), 'hex');
}

/**
 * @returns `{ xdr }`, unsigned, with its footprint already simulated.
 */
export async function buildOutbound(
  { from, amount, recipient },
  { rpcUrl, contractId, networkPassphrase, baseFee = '1000000', serverImpl = null },
) {
  if (!from) throw new Error('an outbound burn needs a source account');

  const bytes = evmAddressBytes(recipient);
  const server = serverImpl ?? new rpc.Server(rpcUrl);
  const contract = new Contract(contractId);

  const source = await server.getAccount(from);
  const built = new TransactionBuilder(source, { fee: baseFee, networkPassphrase })
    .addOperation(
      contract.call(
        'bridge',
        new Address(from).toScVal(),
        nativeToScVal(BigInt(amount), { type: 'i128' }),
        nativeToScVal(bytes, { type: 'bytes' }),
      ),
    )
    .setTimeout(300)
    .build();

  // Simulated here rather than in the browser, because an invocation without
  // its footprint is not submittable and finding that out after signing is a
  // signature spent on nothing.
  const prepared = await server.prepareTransaction(built);
  return { xdr: prepared.toXDR() };
}
