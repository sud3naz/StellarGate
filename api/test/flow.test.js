import test from 'node:test';
import assert from 'node:assert/strict';

import { STATES, OrderViolation, next, advance, retryable } from '../src/flow.js';

test('a fresh address is asked to sign before anything is committed', () => {
  const step = next({ state: STATES.QUOTED, needs: 'account+trustline' });
  assert.equal(step.action, 'collect-signature');
});

test('an address that is already set up is not asked to sign for nothing', () => {
  const step = next({ state: STATES.QUOTED, needs: 'nothing' });
  assert.equal(step.action, 'burn', 'the common case, and it should be the fast one');
});

test('the burn only follows a setup that is actually in hand', () => {
  const held = next({ state: STATES.SIGNED, needs: 'trustline', setupHeld: true });
  assert.equal(held.action, 'burn');

  assert.throws(
    () => next({ state: STATES.SIGNED, needs: 'trustline', setupHeld: false }),
    OrderViolation,
  );
});

test('provisioning happens inside the attestation wait, not after it', () => {
  const step = next({ state: STATES.BURNED, needs: 'account+trustline', attested: false });
  assert.equal(step.action, 'submit-setup', 'that wait is minutes of dead time');
});

test('delivery waits on Circle, not on us', () => {
  assert.equal(next({ state: STATES.PROVISIONED, attested: false }).action, 'wait');
  assert.equal(next({ state: STATES.PROVISIONED, attested: true }).action, 'deliver');
});

test('a transfer to a ready address skips provisioning entirely', () => {
  assert.equal(next({ state: STATES.BURNED, needs: 'nothing', attested: true }).action, 'deliver');
});

// --- the two invariants ----------------------------------------------------

test('we never take money we cannot deliver', () => {
  // Burning before holding the user's signature is the state where their USDC
  // is gone and the account it should land in cannot be created.
  assert.throws(
    () => advance({ state: STATES.QUOTED, needs: 'trustline', setupHeld: false }, STATES.BURNED),
    OrderViolation,
  );

  const safe = advance(
    { state: STATES.SIGNED, needs: 'trustline', setupHeld: true },
    STATES.BURNED,
  );
  assert.equal(safe.state, STATES.BURNED);
});

test('an address that needs nothing may burn without a signature', () => {
  const step = advance({ state: STATES.QUOTED, needs: 'nothing', setupHeld: false }, STATES.BURNED);
  assert.equal(step.state, STATES.BURNED);
});

test('no XLM leaves before a burn', () => {
  // The attack is free otherwise: connect a wallet, ask for an account,
  // repeat. Three XLM a time, and it is spent rather than locked.
  for (const state of [STATES.QUOTED, STATES.SIGNED]) {
    assert.throws(
      () =>
        advance(
          { state, needs: 'account+trustline', setupHeld: true, fundsUser: true, activationPaid: true },
          STATES.PROVISIONED,
        ),
      OrderViolation,
      `funding from ${state} would cost us three XLM per browser tab`,
    );
  }
});

test('no XLM leaves for an activation nobody paid for', () => {
  // The burn happened, but without the activation fee. Sending the XLM anyway
  // would make the five dollars optional.
  assert.throws(
    () =>
      advance(
        {
          state: STATES.BURNED,
          needs: 'account+trustline',
          setupHeld: true,
          fundsUser: true,
          activationPaid: false,
        },
        STATES.PROVISIONED,
      ),
    OrderViolation,
  );

  const paid = advance(
    {
      state: STATES.BURNED,
      needs: 'account+trustline',
      setupHeld: true,
      fundsUser: true,
      activationPaid: true,
    },
    STATES.PROVISIONED,
  );
  assert.equal(paid.state, STATES.PROVISIONED);
});

/**
 * The gate is on the XLM, not on whether an account exists. An account holding
 * 1.2 XLM exists and still cannot afford a trustline, so it gets funded, and
 * therefore has to have paid, exactly like an address with no account at all.
 */
test('a top-up is gated the same way a creation is', () => {
  assert.throws(
    () =>
      advance(
        { state: STATES.BURNED, needs: 'trustline', setupHeld: true, fundsUser: true, activationPaid: false },
        STATES.PROVISIONED,
      ),
    OrderViolation,
    'an existing account is not a licence to hand out XLM',
  );

  const paid = advance(
    { state: STATES.BURNED, needs: 'trustline', setupHeld: true, fundsUser: true, activationPaid: true },
    STATES.PROVISIONED,
  );
  assert.equal(paid.state, STATES.PROVISIONED);
});

/// An account that can pay its own reserve costs us a transaction fee and
/// nothing more, so it must not be gated behind a fee the user never owed.
test('a trustline the user pays for themselves needs no activation fee', () => {
  const done = advance(
    { state: STATES.BURNED, needs: 'trustline', setupHeld: true, fundsUser: false, activationPaid: false },
    STATES.PROVISIONED,
  );
  assert.equal(done.state, STATES.PROVISIONED);
});

test('delivery cannot be claimed out of nowhere', () => {
  assert.throws(
    () => advance({ state: STATES.QUOTED, needs: 'nothing' }, STATES.DELIVERED),
    OrderViolation,
  );
});

test('an unknown state is refused rather than guessed at', () => {
  assert.throws(() => next({ state: 'halfway' }), OrderViolation);
});

// --- recovery --------------------------------------------------------------

test('a delivery that arrived too early is retried, not written off', () => {
  // The forwarder's transfer reverts and the CCTP message survives, so being
  // early costs time and nothing else.
  assert.equal(retryable('op_no_trust'), true);
  assert.equal(retryable('op_no_destination'), true);
});

test('a genuine failure is not retried forever', () => {
  assert.equal(retryable('op_line_full'), false);
  assert.equal(retryable('tx_bad_auth'), false);
});
