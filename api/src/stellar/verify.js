/**
 * Reading a setup before the funder signs it.
 *
 * The setup goes out to the browser, comes back with the user's signature,
 * and is then signed by the funder and submitted. Until this file existed,
 * nothing in between asked whether what came back was what went out. The
 * funder signed any envelope that happened to contain a native payment, and
 * an envelope is just bytes anyone can build: a burn of six USDC, a POST to
 * `/transfers` carrying "funder pays me everything", and the watcher would
 * verify the burn, take the claim, add the funder's signature and send it.
 * The gate on the burn was real and the thing behind the gate was not
 * checked.
 *
 * So this checks it, and it checks the whole thing rather than looking for
 * a payment. A setup the funder may sign is exactly one of three shapes,
 * the three {activation.js} builds, with our channel as the source, our
 * channel's signature already on it, our funder as the only payer, the
 * burn's recipient as the only payee, and the configured XLM as the only
 * amount. Anything else, an extra operation, a different destination, a
 * larger amount, a `setOptions`, a fee bump around the lot, is refused with
 * the reason. It fails closed: an operation type this file does not name is
 * a refusal.
 *
 * The channel signature is the part that ties the envelope to `/setup`.
 * The shape alone would let somebody build their own correctly-shaped
 * setup with a sequence number of their choosing; requiring a signature
 * only our channel key can make means every envelope the funder signs was
 * built here, against a sequence number this server reserved.
 */

import { Keypair, MuxedAccount, StrKey, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';

import { toStroops } from './account.js';

export class ForeignSetup extends Error {}

const refuse = (why) => {
  throw new ForeignSetup(`refusing to sign this setup: ${why}`);
};

/** The `G…` under an `M…`, or the `G…` itself. */
export function underlyingAccount(address) {
  if (StrKey.isValidMed25519PublicKey(address)) {
    return MuxedAccount.fromAddress(address, '0').baseAccount().accountId();
  }
  if (StrKey.isValidEd25519PublicKey(address)) return address;
  return refuse(`${address} is not a Stellar account address`);
}

function sameAsset(line, asset) {
  return line?.code === asset.getCode() && line?.issuer === asset.getIssuer();
}

/**
 * Throws {ForeignSetup} unless `signedXdr` is a setup this server built for
 * `recipient`. Returns the parsed transaction otherwise.
 *
 * @param channelAccounts Public keys of every channel in the pool.
 * @param funderAddress   The only account allowed to be a payer.
 * @param asset           The USDC the trustline must be for.
 * @param startingXlm     The exact amount an activation or top-up may send.
 */
export function assertSetupIsOurs(
  signedXdr,
  { networkPassphrase, recipient, channelAccounts, funderAddress, asset, startingXlm },
) {
  if (!networkPassphrase) refuse('no network passphrase to read it under');
  if (!recipient) refuse('no recipient to check it against');
  if (!channelAccounts?.length) refuse('no channel accounts to check the source against');
  if (!funderAddress) refuse('no funder address to check the payer against');
  if (!asset) refuse('no asset to check the trustline against');

  let tx;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch (error) {
    refuse(`it does not parse (${error?.message ?? error})`);
  }
  // A fee bump wraps another transaction, and the funder would be signing
  // the wrapper. Nothing here builds one.
  if (!(tx instanceof Transaction)) refuse('it is a fee bump, and setups are never fee-bumped');

  // 1. Sourced from a channel of ours, and signed by it.
  if (!channelAccounts.includes(tx.source)) {
    refuse(`its source ${tx.source} is not one of our channel accounts`);
  }
  const hash = tx.hash();
  const channel = Keypair.fromPublicKey(tx.source);
  const channelSigned = tx.signatures.some(
    (sig) => sig.hint().equals(channel.signatureHint()) && channel.verify(hash, sig.signature()),
  );
  if (!channelSigned) refuse('it does not carry the channel signature that /setup puts on it');

  if (tx.memo?.type !== 'none') refuse('setups carry no memo');

  // 2. The operations, as one of the three shapes and nothing else.
  const user = underlyingAccount(recipient);
  const ops = tx.operations;
  const expectedXlm = toStroops(startingXlm);

  const isTrustline = (op) =>
    op.type === 'changeTrust' && op.source === user && sameAsset(op.line, asset);

  const isOurPayout = (op) => {
    if (op.source !== funderAddress) return false;
    if (op.type === 'createAccount') {
      return op.destination === user && toStroops(op.startingBalance) === expectedXlm;
    }
    if (op.type === 'payment') {
      return (
        op.destination === user &&
        op.asset?.isNative?.() === true &&
        toStroops(op.amount) === expectedXlm
      );
    }
    return false;
  };

  if (ops.length === 1) {
    if (!isTrustline(ops[0])) {
      refuse(`a one-operation setup must be the recipient's USDC trustline, not ${describe(ops[0])}`);
    }
  } else if (ops.length === 2) {
    if (!isOurPayout(ops[0])) {
      refuse(`the first operation must send exactly ${startingXlm} XLM from the funder to the recipient, not ${describe(ops[0])}`);
    }
    if (!isTrustline(ops[1])) {
      refuse(`the second operation must be the recipient's USDC trustline, not ${describe(ops[1])}`);
    }
  } else {
    refuse(`a setup has one or two operations, this has ${ops.length}`);
  }

  return tx;
}

function describe(op) {
  const who = op.source ? `from ${op.source.slice(0, 5)}…` : 'from the source';
  const to = op.destination ? ` to ${op.destination.slice(0, 5)}…` : '';
  const amount = op.amount ?? op.startingBalance;
  return `${op.type} ${who}${to}${amount ? ` for ${amount}` : ''}`;
}
