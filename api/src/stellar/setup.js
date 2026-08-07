/**
 * Building the transaction the user signs, and signing our half of it.
 *
 * This is the piece that has to live on the server even though it is the
 * user's signature being collected: the channel account's sequence number and
 * the funder's address are both ours, and neither belongs in a browser.
 *
 * What goes back is deliberately incomplete. The channel signs — it owns the
 * sequence — and the funder does not, because a transaction carrying the
 * funder's signature is one the user can submit themselves for three XLM and
 * no burn. The signature that makes `createAccount` work is added in
 * {submit}, after the burn has been read off the source chain.
 */

import { Account } from '@stellar/stellar-sdk';

import { inspect, baseReserve } from './account.js';
import { buildActivation, buildTopUp, buildTrustline, plan } from './activation.js';

async function loadChannel(horizon, address, fetchImpl) {
  const response = await fetchImpl(`${horizon}/accounts/${address}`);
  if (!response.ok) throw new Error(`horizon accounts: ${response.status}`);
  const body = await response.json();
  return new Account(address, body.sequence);
}

/**
 * @returns `null` when the destination needs nothing, or `{ needed, xdr,
 *          fundsUser }` where the XDR is signed by the channel alone.
 */
export async function buildSetupFor(
  recipient,
  {
    horizon,
    asset,
    networkPassphrase,
    channelSigner,
    funderAddress,
    startingXlm = '3',
    timeoutSeconds = 45 * 60,
    baseFee = '10000',
    amount = null,
    fetchImpl = fetch,
  },
) {
  const inspection = await inspect(horizon, recipient, asset, { amount, fetchImpl });
  const reserve = await baseReserve(horizon, { fetchImpl });
  const decision = plan(inspection, { reserveStroops: reserve });

  if (decision.kind === 'none') return null;

  const channel = await loadChannel(horizon, channelSigner.publicKey(), fetchImpl);
  const shared = {
    channel,
    user: recipient,
    asset,
    networkPassphrase,
    timeoutSeconds,
    baseFee,
  };

  let tx;
  if (decision.kind === 'activation') {
    tx = buildActivation({ ...shared, funder: funderAddress, startingBalance: startingXlm });
  } else if (decision.kind === 'topup') {
    // An account that exists but cannot afford its own trustline reserve. Same
    // three XLM, same fee, different operation — from the user's side the
    // situation is identical, which is the whole argument for the fee being
    // shaped this way.
    tx = buildTopUp({ ...shared, funder: funderAddress, amount: startingXlm });
  } else {
    tx = buildTrustline(shared);
  }

  // The channel owns the sequence, so it signs. The funder does not, and that
  // is the point rather than an oversight.
  tx.sign(channelSigner);

  return { needed: decision.kind, xdr: tx.toXDR(), fundsUser: decision.fundsUser };
}
