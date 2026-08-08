/**
 * The order a transfer happens in, as rules rather than as prose.
 *
 * Two invariants carry the whole design, and both are easy to break by
 * accident once there is a UI, a queue and a retry loop in the way:
 *
 *   1. **The user's signature comes before the burn.** Not for convenience, *      because the setup transaction needs their key, and once they have
 *      burned on Base the money is committed. Collecting the signature after
 *      the burn creates a state where we hold their USDC and cannot deliver
 *      it because they closed the tab.
 *
 *   2. **No XLM leaves before a burn that paid for it.** Activation sends
 *      three XLM outright, spent, not lent, and unrecoverable. An endpoint
 *      that funds Stellar accounts on request costs three XLM per browser tab
 *      to drain. So funding is gated twice: on a completed burn, and on that
 *      burn having carried the activation fee.
 *
 * Everything past the burn is retryable. The CCTP message is not consumed by a
 * failed delivery, so a late trustline costs time and nothing else.
 */

export const STATES = {
  /// Both wallets connected, destination inspected, nothing committed.
  QUOTED: 'quoted',
  /// The setup transaction is signed and held. Costs nothing if abandoned.
  SIGNED: 'signed',
  /// USDC burned on the source chain. Committed from here.
  BURNED: 'burned',
  /// The account exists and holds a USDC trustline.
  PROVISIONED: 'provisioned',
  /// USDC is in the user's account.
  DELIVERED: 'delivered',
};

export class OrderViolation extends Error {}

/**
 * The next thing to do, given where a transfer is.
 *
 * @param transfer.state      One of {STATES}.
 * @param transfer.needs      From `inspect`: what the destination is missing.
 * @param transfer.attested   Whether Circle has attested the burn.
 * @param transfer.setupHeld  Whether a signed setup transaction is in hand.
 * @param transfer.fundsUser  From `plan`: whether our XLM is about to leave.
 */
export function next(transfer) {
  const { state, needs, attested = false, setupHeld = false } = transfer;

  switch (state) {
    case STATES.QUOTED:
      // An address that is already set up has nothing to sign, so asking for a
      // signature would be theatre. Straight to the burn.
      return needs === 'nothing'
        ? { action: 'burn', reason: 'destination is already able to receive' }
        : { action: 'collect-signature', reason: `destination needs ${needs}` };

    case STATES.SIGNED:
      if (!setupHeld) {
        throw new OrderViolation('signed without a setup transaction in hand');
      }
      return { action: 'burn', reason: 'setup is held, the burn is safe to make' };

    case STATES.BURNED:
      // The provisioning goes in while the attestation is pending. That wait
      // is minutes on this route, and it is otherwise dead time.
      if (needs !== 'nothing') {
        return { action: 'submit-setup', reason: 'provision during the attestation wait' };
      }
      return attested
        ? { action: 'deliver', reason: 'attested and the destination is ready' }
        : { action: 'wait', reason: 'waiting on Circle' };

    case STATES.PROVISIONED:
      return attested
        ? { action: 'deliver', reason: 'attested and the destination is ready' }
        : { action: 'wait', reason: 'waiting on Circle' };

    case STATES.DELIVERED:
      return { action: 'done', reason: 'USDC is in the account' };

    default:
      throw new OrderViolation(`unknown state: ${state}`);
  }
}

/**
 * Refuses a transition that would break either invariant. Called on the way
 * in, so a bug in a caller surfaces as a rejection rather than as a drained
 * sponsor or an undeliverable payment.
 */
export function advance(transfer, to) {
  const { state, needs, setupHeld = false, activationPaid = false, fundsUser = false } = transfer;

  if (to === STATES.BURNED && needs !== 'nothing' && !setupHeld) {
    throw new OrderViolation('refusing to burn before the setup is signed and held');
  }

  if (to === STATES.PROVISIONED) {
    if (state !== STATES.BURNED) {
      throw new OrderViolation('refusing to provision a transfer that has not paid');
    }
    // The gate is on the XLM, not on the shape of the fix. Creating an account
    // and topping up one that cannot afford its trustline both spend three
    // XLM; adding a trustline to an account that can pay its own way spends a
    // transaction fee and nothing more.
    if (fundsUser && !activationPaid) {
      throw new OrderViolation('refusing to send XLM for an activation nobody paid for');
    }
  }

  if (to === STATES.DELIVERED && state !== STATES.BURNED && state !== STATES.PROVISIONED) {
    throw new OrderViolation('nothing to deliver');
  }

  return { ...transfer, state: to };
}

/**
 * A delivery that failed because the destination was not ready yet. The CCTP
 * message survives, so this is a retry rather than a loss, but only if the
 * provisioning is actually in place, otherwise it would spin forever.
 */
export function retryable(failure) {
  return failure === 'op_no_trust' || failure === 'op_no_destination';
}
