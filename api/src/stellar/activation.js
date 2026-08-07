import { Asset, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

/**
 * Making a Stellar address able to hold USDC.
 *
 * There are two shapes, and only one of them costs anybody anything:
 *
 * **The address has no account.** We buy it one: three XLM sent outright, plus
 * the trustline in the same transaction. One XLM is the account reserve, half
 * an XLM the trustline reserve, and the rest is the user's own fee money. That
 * last part is the reason this is a payment and not a sponsorship — a sponsored
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
 * An account that exists but cannot cover its own trustline reserve — a
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
 * Submits an activation that was signed earlier.
 *
 * `op_already_exists` is not a failure: two transfers to the same fresh
 * address can race, and the loser finds the work already done. Retrying that
 * forever would be the actual bug.
 */
export async function submit(horizon, signedXdr, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${horizon}/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ tx: signedXdr }).toString(),
  });

  const body = await response.json().catch(() => ({}));
  if (response.ok) return { ok: true, hash: body.hash, alreadyDone: false };

  const codes = body?.extras?.result_codes;
  const operations = codes?.operations || [];
  const alreadyDone =
    operations.length > 0 &&
    operations.every((code) => code === 'op_success' || code === 'op_already_exists');

  return {
    ok: false,
    alreadyDone,
    transactionCode: codes?.transaction,
    operationCodes: operations,
    status: response.status,
  };
}
