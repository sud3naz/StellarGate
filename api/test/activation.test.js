import test from 'node:test';
import assert from 'node:assert/strict';

import { Account, Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

import { buildActivation, buildTopUp, buildTrustline, plan, submit } from '../src/stellar/activation.js';
import { USDC } from '../src/config.js';

const asset = USDC.testnet;
const passphrase = Networks.TESTNET;
const RESERVE = 5_000_000n; // 0.5 XLM

const funderKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const channelKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const userKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));

/// A fresh channel each time: TransactionBuilder bumps the sequence on the
/// Account it is handed, so a shared one makes the tests depend on their order.
const args = () => ({
  channel: new Account(channelKey.publicKey(), '100'),
  user: userKey.publicKey(),
  asset,
  networkPassphrase: passphrase,
  timeoutSeconds: 45 * 60,
  baseFee: '10000',
});

test('a new account is bought outright and given its trustline in one go', () => {
  const tx = buildActivation({ ...args(), funder: funderKey.publicKey(), startingBalance: '3' });

  assert.deepEqual(
    tx.operations.map((op) => op.type),
    ['createAccount', 'changeTrust'],
  );
});

/**
 * The reason this is a payment and not a sponsorship. One XLM for the account,
 * half for the trustline, and the rest is the user's own fee money — without
 * it they could receive USDC and be unable to send it anywhere.
 */
test('three XLM leaves the user able to pay their own way', () => {
  const tx = buildActivation({ ...args(), funder: funderKey.publicKey(), startingBalance: '3' });
  const create = tx.operations.find((op) => op.type === 'createAccount');

  const sent = BigInt(Number(create.startingBalance) * 1e7);
  const locked = 2n * RESERVE + 1n * RESERVE; // account, then trustline

  assert.equal(create.source, funderKey.publicKey(), 'we pay, not the channel');
  assert.ok(sent > locked, 'anything left over is what the user spends on fees');
  assert.equal(sent - locked, 15_000_000n, '1.5 XLM of headroom, ~150,000 operations');
});

test('the trustline is the user’s to agree to, in both shapes', () => {
  const created = buildActivation({
    ...args(),
    funder: funderKey.publicKey(),
    startingBalance: '3',
  });
  const existing = buildTrustline(args());

  for (const tx of [created, existing]) {
    const trust = tx.operations.find((op) => op.type === 'changeTrust');
    assert.equal(trust.source, userKey.publicKey());
  }
});

test('an existing account gets a trustline and no XLM from us', () => {
  const tx = buildTrustline(args());

  assert.deepEqual(
    tx.operations.map((op) => op.type),
    ['changeTrust'],
    'no createAccount, so nothing is spent',
  );
  assert.equal(tx.source, channelKey.publicKey(), 'we still cover the transaction fee');
});

test('creating an account without a funder is refused rather than half-built', () => {
  assert.throws(
    () => buildActivation({ ...args(), funder: null, startingBalance: '3' }),
    /somebody paying for it/,
  );
});

test('the sequence comes from the channel, so a held transaction survives', () => {
  const tx = buildTrustline(args());
  assert.equal(tx.sequence, '101');
});

test('both signatures hold up when the transaction is rebuilt', () => {
  const tx = buildActivation({ ...args(), funder: funderKey.publicKey(), startingBalance: '3' });
  tx.sign(channelKey, funderKey, userKey);

  assert.equal(TransactionBuilder.fromXDR(tx.toXDR(), passphrase).signatures.length, 3);
});

// --- who pays -------------------------------------------------------------

test('an address with no account is the only one charged', () => {
  const decision = plan({ needs: 'account+trustline' }, { reserveStroops: RESERVE });

  assert.equal(decision.kind, 'activation');
  assert.equal(decision.chargeActivation, true);
  assert.equal(decision.fundsUser, true);
});

/// The common case, and it must stay free: this is somebody who already uses
/// Stellar, and charging them five dollars for an account they have is how
/// you lose them.
test('an account that only lacks the trustline is not a new user', () => {
  const decision = plan(
    { needs: 'trustline', spendableStroops: 20_000_000n },
    { reserveStroops: RESERVE },
  );

  assert.equal(decision.kind, 'trustline');
  assert.equal(decision.chargeActivation, false);
  assert.equal(decision.fundsUser, false);
});

test('an address that is already set up is charged nothing and given nothing', () => {
  const decision = plan({ needs: 'nothing' }, { reserveStroops: RESERVE });
  assert.equal(decision.kind, 'none');
  assert.equal(decision.chargeActivation, false);
});

/**
 * The line is "can this address hold USDC without our help", not "does an
 * account exist". An account sitting on 1.2 XLM exists and still cannot: it is
 * short of a trustline reserve with no way to close the gap. Same problem as
 * having no account at all, so the same three XLM and the same fee.
 */
test('an account too poor for its own trustline is treated as a new user', () => {
  const decision = plan(
    { needs: 'trustline', spendableStroops: 2_000_000n }, // 0.2 XLM, needs 0.5
    { reserveStroops: RESERVE },
  );

  assert.equal(decision.kind, 'topup');
  assert.equal(decision.chargeActivation, true);
  assert.equal(decision.fundsUser, true);
  assert.equal(decision.shortfallStroops, 3_000_000n, '0.3 XLM short');
});

test('a top-up sends XLM to an account that is already there', () => {
  const tx = buildTopUp({ ...args(), funder: funderKey.publicKey(), amount: '3' });

  assert.deepEqual(
    tx.operations.map((op) => op.type),
    ['payment', 'changeTrust'],
    'a payment, not a creation: the account exists',
  );

  const payment = tx.operations.find((op) => op.type === 'payment');
  assert.equal(payment.asset.isNative(), true);
  assert.equal(payment.destination, userKey.publicKey());
  assert.equal(payment.source, funderKey.publicKey(), 'we pay');
  assert.equal(Number(payment.amount), 3, 'the same three XLM a new account gets');
});

test('a top-up without a funder is refused rather than half-built', () => {
  assert.throws(
    () => buildTopUp({ ...args(), funder: null, amount: '3' }),
    /somebody paying for it/,
  );
});

test('exactly enough is enough', () => {
  const decision = plan(
    { needs: 'trustline', spendableStroops: RESERVE },
    { reserveStroops: RESERVE },
  );
  assert.equal(decision.kind, 'trustline');
});

// --- submission -----------------------------------------------------------

function response(body, status) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

test('losing the race to another transfer is not a failure', async () => {
  const result = await submit('https://horizon.example', 'AAAA', {
    fetchImpl: response(
      {
        extras: {
          result_codes: { transaction: 'tx_failed', operations: ['op_already_exists', 'op_success'] },
        },
      },
      400,
    ),
  });

  assert.equal(result.alreadyDone, true, 'the address ended up usable either way');
});

test('an underfunded funder is a real failure and needs a human', async () => {
  const result = await submit('https://horizon.example', 'AAAA', {
    fetchImpl: response(
      { extras: { result_codes: { transaction: 'tx_failed', operations: ['op_underfunded'] } } },
      400,
    ),
  });

  assert.equal(result.ok, false);
  assert.equal(result.alreadyDone, false);
  assert.deepEqual(result.operationCodes, ['op_underfunded']);
});
