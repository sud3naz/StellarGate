import { Asset, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

import { assertPaidForActivation } from '../watcher/burn.js';

/**
 * Making a Stellar address able to hold USDC.
 *
 * There are two shapes, and only one of them costs anybody anything:
 *
 * **The address has no account.** We buy it one: three XLM sent outright, plus
 * the trustline in the same transaction. One XLM is the account reserve, half
 * an XLM the trustline reserve, and the rest is the user's own fee money. That
 * last part is the reason this is a payment and not a sponsorship, a sponsored
 * account holds zero XLM, and an account holding zero XLM cannot pay a
 * transaction fee, so it could receive USDC and then be unable to send it
 * anywhere without us signing for every move. Three XLM buys independence.
 * This is what {ACTIVATION_FEE} on the source side pays for.
 *
 * **The account exists but has no USDC trustline.** It already holds XLM, so
 * it can afford its own half-XLM reserve; it just has to agree to the
 * trustline. We pay the transaction fee and nothing else, and the user is
 * charged nothing, because they are not a new user.
 *
 * The transaction source is a channel account in both cases. This is signed
 * before the burn and submitted up to twenty minutes later, and a sequence
 * number drawn from a shared wallet would be invalidated by the next transfer
 * in that window.
 */

/** Reserves an account must hold: two for itself, one per subentry. */
export const ACCOUNT_RESERVES = 2n;
export const TRUSTLINE_RESERVES = 1n;

export function buildActivation({
  channel,
  funder,
  user,
  asset,
  startingBalance,
  networkPassphrase,
  timeoutSeconds,
  baseFee,
  trustLimit,
}) {
  if (!funder) throw new Error('an account cannot be created without somebody paying for it');

  return new TransactionBuilder(channel, { fee: baseFee, networkPassphrase })
    .addOperation(
      Operation.createAccount({ destination: user, startingBalance, source: funder }),
    )
    // Sourced to the user, because the trustline is theirs and the protocol
    // will not take our word for it.
    .addOperation(Operation.changeTrust({ asset, limit: trustLimit, source: user }))
    .setTimeout(timeoutSeconds)
    .build();
}

/**
 * An account that exists but cannot cover its own trustline reserve, a
 * balance somewhere between one XLM and one and a half. It gets the same three
 * XLM and pays the same fee as an address with no account at all, because from
 * the user's side the situation is identical: they cannot hold USDC and cannot
 * fix that themselves. The only difference is that the account is already
 * there, so this is a payment rather than a creation.
 */
export function buildTopUp({
  channel,
  funder,
  user,
  asset,
  amount,
  networkPassphrase,
  timeoutSeconds,
  baseFee,
  trustLimit,
}) {
  if (!funder) throw new Error('a top-up cannot be sent without somebody paying for it');

  return new TransactionBuilder(channel, { fee: baseFee, networkPassphrase })
    .addOperation(Operation.payment({ destination: user, asset: Asset.native(), amount, source: funder }))
    .addOperation(Operation.changeTrust({ asset, limit: trustLimit, source: user }))
    .setTimeout(timeoutSeconds)
    .build();
}

/**
 * The trustline alone, for an account that already exists and can pay its own
 * reserve. We cover the transaction fee so the user needs no XLM in hand for
 * this either, but the half-XLM reserve comes out of their own balance.
 */
export function buildTrustline({
  channel,
  user,
  asset,
  networkPassphrase,
  timeoutSeconds,
  baseFee,
  trustLimit,
}) {
  return new TransactionBuilder(channel, { fee: baseFee, networkPassphrase })
    .addOperation(Operation.changeTrust({ asset, limit: trustLimit, source: user }))
    .setTimeout(timeoutSeconds)
    .build();
}

/**
 * What a destination needs, and who pays for it.
 *
 * The line is not "does an account exist" but **"can this address hold USDC
 * without our help"**. An address with no account cannot. Nor can an account
 * sitting on 1.2 XLM: it exists, but it is half an XLM short of a trustline
 * and has no way to close that gap on its own. Both are the same problem
 * wearing different clothes, so both get three XLM and both pay the fee.
 *
 * What separates them is only the operation: one needs the account created,
 * the other needs it topped up.
 */
export function plan(inspection, { reserveStroops }) {
  if (inspection.needs === 'nothing') {
    return { kind: 'none', chargeActivation: false, fundsUser: false };
  }

  if (inspection.needs === 'account+trustline') {
    return { kind: 'activation', chargeActivation: true, fundsUser: true };
  }

  const needed = reserveStroops * TRUSTLINE_RESERVES;
  if (inspection.spendableStroops !== undefined && inspection.spendableStroops < needed) {
    return {
      kind: 'topup',
      chargeActivation: true,
      fundsUser: true,
      reason: 'the account exists but cannot afford its own trustline reserve',
      shortfallStroops: needed - inspection.spendableStroops,
    };
  }

  // The common case: an account with XLM of its own, which pays its own
  // reserve and owes us nothing but a signature.
  return { kind: 'trustline', chargeActivation: false, fundsUser: false };
}

/**
 * Whether a signed setup would spend our own XLM, read off the transaction
 * rather than off what the caller says about it.
 *
 * Creating an account and topping one up both send XLM outright. Adding a
 * trustline to an account that can pay its own reserve costs a transaction fee
 * and nothing more, and is deliberately not in this list, gating it would be
 * charging a user who never owed anything.
 */
export function spendsOurXlm(signedXdr, networkPassphrase) {
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  return tx.operations.some(
    (op) => op.type === 'createAccount' || (op.type === 'payment' && op.asset?.isNative?.()),
  );
}

/**
 * Submits a setup that was signed earlier, adding the last signature it needs.
 *
 * @param paidBurn A proof from {verifyPaidBurn}, required when the transaction
 *        sends XLM. Not a flag, a value that can only be got by reading the
 *        burn receipt off the source chain.
 * @param funderSigner The keypair whose XLM is being sent. Signs **here**,
 *        after the proof, and never before.
 *
 * That last part is the whole shape of it. The setup has to be built by us, * the browser cannot know the channel's sequence number or the funder's
 * address, and it has to be signed by the user before the burn, because
 * afterwards they may be gone. But a transaction that leaves here already
 * carrying the funder's signature is a transaction the user can simply submit
 * themselves: three XLM, no burn, once per request. That is the attack the
 * ordering was supposed to prevent, arriving by post.
 *
 * So the funder signs last, on this side of the gate. What the browser holds
 * in the meantime is real and useless: valid, theirs, and short exactly the
 * signature that makes `createAccount` work.
 *
 * This is where the gate lives, rather than beside it. `flow.js` already
 * refuses to provision a transfer that has not paid, and on 7 August that was
 * not enough: a burn failed silently, `advance()` was never consulted, this
 * function was called anyway, and three XLM left for an activation nobody had
 * bought. A rule that can be walked past is a comment.
 *
 * `networkPassphrase` is required for the same reason. Making it optional
 * would mean a caller who omits it skips the check, which is the failure mode
 * this is meant to close.
 *
 * `op_already_exists` is not a failure: two transfers to the same fresh
 * address can race, and the loser finds the work already done. Retrying that
 * forever would be the actual bug.
 *
 * Some refusals are final. A setup whose sequence number has been used, or
 * whose time bound has passed, will be refused identically forever, and the
 * only way forward is a new setup with a new signature from the user. Those
 * come back as `dead`, so the watcher can drop the transaction and ask for
 * another rather than retry a corpse. But "the sequence was used" includes
 * the case where *this very transaction* used it, submitted once and
 * unanswered, so before anything is called dead its hash is looked up on
 * Horizon: found and succeeded means done, not dead.
 */

/**
 * Transaction-level codes that no retry of the same envelope can fix.
 * Everything else, an underfunded funder, a fee too low for a busy ledger,
 * a Horizon having a bad minute, is worth another go with the same bytes.
 */
export const DEAD_CODES = new Set([
  'tx_bad_seq',
  'tx_too_late',
  'tx_bad_auth',
  'tx_bad_auth_extra',
  'tx_malformed',
  'tx_missing_operation',
  'tx_not_supported',
]);

/** Whether a transaction with this hash has already succeeded on the ledger. */
export async function alreadyApplied(horizon, hash, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${horizon}/transactions/${hash}`);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`horizon transactions: ${response.status}`);
  const body = await response.json().catch(() => ({}));
  return body.successful === true;
}

export async function submit(
  horizon,
  signedXdr,
  { networkPassphrase, paidBurn = null, funderSigner = null, fetchImpl = fetch } = {},
) {
  if (!networkPassphrase) {
    throw new Error('submit needs the network passphrase to see what it is submitting');
  }

  let toSend = signedXdr;

  if (spendsOurXlm(signedXdr, networkPassphrase)) {
    assertPaidForActivation(paidBurn);

    if (!funderSigner) {
      throw new Error('a transaction that sends XLM needs the funder to sign it here');
    }
    const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
    tx.sign(funderSigner);
    toSend = tx.toXDR();
  }

  // Signatures do not change the hash, so this names the transaction whether
  // or not the funder just signed it, and whether or not it went out before.
  const hash = TransactionBuilder.fromXDR(toSend, networkPassphrase).hash().toString('hex');

  const response = await fetchImpl(`${horizon}/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ tx: toSend }).toString(),
  });

  const body = await response.json().catch(() => ({}));
  if (response.ok) return { ok: true, hash: body.hash ?? hash, alreadyDone: false, dead: false };

  const codes = body?.extras?.result_codes;
  const transactionCode = codes?.transaction;
  const operations = codes?.operations || [];
  let alreadyDone =
    operations.length > 0 &&
    operations.every((code) => code === 'op_success' || code === 'op_already_exists');

  let dead = false;
  if (!alreadyDone && DEAD_CODES.has(transactionCode)) {
    // A used sequence may have been used by us. Ask before giving up on it.
    if (await alreadyApplied(horizon, hash, { fetchImpl })) alreadyDone = true;
    else dead = true;
  }

  return {
    ok: false,
    hash,
    alreadyDone,
    dead,
    transactionCode,
    operationCodes: operations,
    status: response.status,
  };
}
