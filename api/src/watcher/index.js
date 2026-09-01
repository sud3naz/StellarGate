/**
 * The loop, as one function that moves a transfer forward by one step.
 *
 * All of the ordering lives in {step}, and the timer around it does nothing
 * but call it, because the ordering is the part that can lose money, and a
 * rule tangled into a scheduler cannot be tested. `flow.js` says what the
 * order is; this is where it actually happens.
 *
 * The sequence, and why it is this way round:
 *
 *   1. **Prove the burn.** Read it off the source chain rather than trust the
 *      record. This is the step that was skipped by hand on 7 August, and it
 *      cost three XLM for an activation nobody had bought.
 *   2. **Provision, once.** The claim is taken before the XLM moves, so a
 *      crash between claiming and submitting costs a wasted claim rather than
 *      a second payout.
 *   3. **Wait for Circle.** Provisioning goes first because it used to happen
 *      inside a fifteen-minute attestation and now happens inside a
 *      twenty-eight second one. Fifteen seconds of margin is not a reason to
 *      do it later.
 *   4. **Deliver.** Nobody else will.
 */

import { STATES } from '../flow.js';
import { ForeignSetup } from '../stellar/verify.js';
import { reverseStep } from './reverse.js';

/**
 * Moves one transfer as far as it can go right now.
 *
 * Every dependency is injected: the point is that this function can be run
 * against nothing at all, and every branch that spends money is reachable in
 * a test.
 *
 * @returns `{ action, reason?, hash? }`, what it did, for a log a human can
 *          read at three in the morning.
 */
export async function step(transfer, deps) {
  const { store, verifyBurn, submitSetup, attest, deliver } = deps;

  if (transfer.deliveredAt) {
    return { action: 'done', reason: 'already delivered' };
  }

  // 1. The burn, proven rather than assumed.
  const proof = await verifyBurn(transfer.txHash, transfer.recipient);
  if (!proof) {
    return { action: 'wait', state: STATES.QUOTED, reason: 'the burn is not on chain yet' };
  }

  // 2. Provisioning, at most once per burn.
  if (transfer.setupXdr && !transfer.provisioned) {
    // Only take a claim when our XLM is actually at stake. A trustline on an
    // account that pays its own reserve costs a transaction fee, and gating it
    // would be charging a user who never owed anything.
    //
    // A claim already held is not a reason to stop. It means an earlier pass
    // took it and never reported back, a crash between claiming and hearing
    // from Horizon, and the honest thing is to send the *same* envelope
    // again: same hash, same sequence number, and a ledger applies that at
    // most once. What must never happen is a second, different setup going
    // out against this burn, and the store allows only one to be held.
    // Marking the transfer provisioned on a held claim, which is what this
    // used to do, declared an account built on the strength of an attempt
    // whose outcome nobody knew.
    if (proof.activate) store.claimActivation(transfer.txHash);

    let result;
    try {
      result = await submitSetup(transfer.setupXdr, proof);
    } catch (error) {
      // The funder refused to sign it: not a setup this server built. It got
      // into the store somehow, past the door or through the file, and
      // retrying it is pointless. Drop it, say why, and keep the claim
      // released, since nothing was spent.
      if (error instanceof ForeignSetup) {
        store.dropSetup(transfer.txHash, error.message);
        return { action: 'setup-refused', state: STATES.BURNED, reason: error.message };
      }
      throw error;
    }
    const failure = `${(result.operationCodes ?? []).join(',') || result.transactionCode}`;

    if (!result.ok && !result.alreadyDone) {
      if (result.dead) {
        // The ledger will never take this envelope: its sequence went to
        // another setup, or its time bound passed. Horizon has already been
        // asked whether it applied, so nothing was spent. Drop it and let
        // the page ask the user to sign a fresh one.
        store.dropSetup(transfer.txHash, failure);
        return {
          action: 'setup-dead',
          state: STATES.BURNED,
          reason: `setup can never apply (${failure}); a new signature is needed`,
        };
      }
      return { action: 'retry-setup', state: STATES.BURNED, reason: `setup failed: ${failure}` };
    }
    store.markProvisioned(transfer.txHash);
  }

  // 3. Circle.
  const attestation = await attest(transfer.txHash);
  if (!attestation?.ready) {
    return {
      action: 'wait',
      state: STATES.BURNED,
      reason: attestation?.delayReason
        ? `waiting on Circle (${attestation.delayReason})`
        : 'waiting on Circle',
    };
  }

  // 4. The delivery, which nobody else is going to make.
  const delivered = await deliver(attestation.message, attestation.attestation);

  if (delivered.done) {
    // The message was already consumed, so an earlier attempt landed and the
    // USDC is where it should be. Recording it is the whole remaining job.
    store.markDelivered(transfer.txHash, delivered.hash ?? null);
    return { action: 'done', state: STATES.DELIVERED, reason: 'already delivered' };
  }

  if (!delivered.ok) {
    return { action: 'retry-delivery', state: STATES.PROVISIONED, reason: delivered.reason };
  }

  store.markDelivered(transfer.txHash, delivered.hash);
  return {
    action: 'delivered',
    state: STATES.DELIVERED,
    hash: delivered.hash,
    reason: attestation.fellBackToStandard
      ? 'delivered, though the fast tier was refused and this took the slow road'
      : 'delivered',
  };
}

/**
 * One pass over everything still owed a delivery.
 *
 * A transfer that throws does not stop the others: one address with a problem
 * should not hold up every other user, and the error is worth surfacing rather
 * than swallowing.
 */
export async function sweep(deps) {
  const { store, onResult = () => {} } = deps;
  const results = [];

  for (const transfer of store.pending()) {
    try {
      // The two directions share a queue and almost nothing else. Going out
      // there is no burn of ours to verify and no account to build, so it
      // would be misleading to run it through the same steps.
      const result =
        transfer.direction === 'out'
          ? await reverseStep(transfer, deps)
          : await step(transfer, deps);
      results.push({ txHash: transfer.txHash, ...result });
      onResult({ txHash: transfer.txHash, ...result });
    } catch (error) {
      const failure = { txHash: transfer.txHash, action: 'error', reason: String(error?.message ?? error) };
      results.push(failure);
      onResult(failure);
    }
  }

  return results;
}
