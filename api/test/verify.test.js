import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Account,
  Asset,
  Keypair,
  MuxedAccount,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import { assertSetupIsOurs, ForeignSetup, underlyingAccount } from '../src/stellar/verify.js';
import { buildActivation, buildTopUp, buildTrustline } from '../src/stellar/activation.js';
import { USDC } from '../src/config.js';

const asset = USDC.testnet;
const passphrase = Networks.TESTNET;

const funderKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const channelKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const userKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
const attackerKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4));
const otherChannel = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5));

const rules = (overrides = {}) => ({
  networkPassphrase: passphrase,
  recipient: userKey.publicKey(),
  channelAccounts: [channelKey.publicKey(), otherChannel.publicKey()],
  funderAddress: funderKey.publicKey(),
  asset,
  startingXlm: '3',
  ...overrides,
});

const built = () => ({
  channel: new Account(channelKey.publicKey(), '100'),
  user: userKey.publicKey(),
  asset,
  networkPassphrase: passphrase,
  timeoutSeconds: 45 * 60,
  baseFee: '10000',
});

/** What /setup hands out, then what the browser hands back. */
function ours(kind) {
  const tx =
    kind === 'activation'
      ? buildActivation({ ...built(), funder: funderKey.publicKey(), startingBalance: '3' })
      : kind === 'topup'
        ? buildTopUp({ ...built(), funder: funderKey.publicKey(), amount: '3' })
        : buildTrustline(built());
  tx.sign(channelKey);
  tx.sign(userKey);
  return tx.toXDR();
}

/** A transaction of the attacker's own making, signed by whoever they like. */
function forged(ops, { source = channelKey.publicKey(), signers = [channelKey, attackerKey] } = {}) {
  const builder = new TransactionBuilder(new Account(source, '100'), {
    fee: '10000',
    networkPassphrase: passphrase,
  });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(60).build();
  for (const key of signers) tx.sign(key);
  return tx.toXDR();
}

const trustlineOp = (source = userKey.publicKey()) => Operation.changeTrust({ asset, source });

// --- the three shapes we build are the three shapes we sign ------------------

test('an activation we built is ours', () => {
  assert.ok(assertSetupIsOurs(ours('activation'), rules()));
});

test('a top-up we built is ours', () => {
  assert.ok(assertSetupIsOurs(ours('topup'), rules()));
});

test('a trustline we built is ours', () => {
  assert.ok(assertSetupIsOurs(ours('trustline'), rules()));
});

test('a muxed recipient is checked against the account underneath it', () => {
  const muxed = new MuxedAccount(new Account(userKey.publicKey(), '0'), '42').accountId();
  assert.equal(underlyingAccount(muxed), userKey.publicKey());
  assert.ok(assertSetupIsOurs(ours('activation'), rules({ recipient: muxed })));
});

// --- the attack, and every neighbour of it ----------------------------------

/**
 * The one that was possible: burn six USDC, post "funder pays me
 * everything" as the setup, and let the watcher add the funder's signature.
 */
test('a payment from the funder to somebody else is refused', () => {
  const xdr = forged([
    Operation.payment({
      source: funderKey.publicKey(),
      destination: attackerKey.publicKey(),
      asset: Asset.native(),
      amount: '100000',
    }),
    trustlineOp(),
  ]);
  assert.throws(() => assertSetupIsOurs(xdr, rules()), ForeignSetup);
});

test('the right recipient for the wrong amount is refused', () => {
  const xdr = forged([
    Operation.createAccount({ source: funderKey.publicKey(), destination: userKey.publicKey(), startingBalance: '3000' }),
    trustlineOp(),
  ]);
  assert.throws(() => assertSetupIsOurs(xdr, rules()), /exactly 3 XLM/);
});

test('an account takeover hidden behind a real-looking payment is refused', () => {
  const xdr = forged([
    Operation.createAccount({ source: funderKey.publicKey(), destination: userKey.publicKey(), startingBalance: '3' }),
    trustlineOp(),
    Operation.setOptions({ source: funderKey.publicKey(), signer: { ed25519PublicKey: attackerKey.publicKey(), weight: 255 } }),
  ]);
  assert.throws(() => assertSetupIsOurs(xdr, rules()), /one or two operations/);
});

test('a setOptions in place of the trustline is refused', () => {
  const xdr = forged([
    Operation.createAccount({ source: funderKey.publicKey(), destination: userKey.publicKey(), startingBalance: '3' }),
    Operation.setOptions({ source: funderKey.publicKey(), masterWeight: 0 }),
  ]);
  assert.throws(() => assertSetupIsOurs(xdr, rules()), /USDC trustline/);
});

test('a trustline for somebody else’s USDC is refused', () => {
  const xdr = forged([Operation.changeTrust({ asset: new Asset('USDC', attackerKey.publicKey()), source: userKey.publicKey() })]);
  assert.throws(() => assertSetupIsOurs(xdr, rules()), ForeignSetup);
});

test('a trustline on the wrong account is refused', () => {
  const xdr = forged([trustlineOp(attackerKey.publicKey())]);
  assert.throws(() => assertSetupIsOurs(xdr, rules()), ForeignSetup);
});

test('a payout to the recipient in the wrong currency is refused', () => {
  const xdr = forged([
    Operation.payment({ source: funderKey.publicKey(), destination: userKey.publicKey(), asset, amount: '3' }),
    trustlineOp(),
  ]);
  assert.throws(() => assertSetupIsOurs(xdr, rules()), ForeignSetup);
});

test('a setup for a different recipient than the burn paid for is refused', () => {
  assert.throws(
    () => assertSetupIsOurs(ours('activation'), rules({ recipient: attackerKey.publicKey() })),
    ForeignSetup,
  );
});

// --- the channel signature is what ties it to /setup ------------------------

test('the right shape without the channel signature is refused', () => {
  const xdr = forged(
    [
      Operation.createAccount({ source: funderKey.publicKey(), destination: userKey.publicKey(), startingBalance: '3' }),
      trustlineOp(),
    ],
    { signers: [userKey] },
  );
  assert.throws(() => assertSetupIsOurs(xdr, rules()), /channel signature/);
});

test('the right shape from an account that is not a channel is refused', () => {
  const xdr = forged(
    [
      Operation.createAccount({ source: funderKey.publicKey(), destination: userKey.publicKey(), startingBalance: '3' }),
      trustlineOp(),
    ],
    { source: attackerKey.publicKey(), signers: [attackerKey, userKey] },
  );
  assert.throws(() => assertSetupIsOurs(xdr, rules()), /not one of our channel accounts/);
});

test('a fee bump around a real setup is refused', () => {
  const inner = TransactionBuilder.fromXDR(ours('activation'), passphrase);
  const bump = TransactionBuilder.buildFeeBumpTransaction(attackerKey, '100000', inner, passphrase);
  bump.sign(attackerKey);
  assert.throws(() => assertSetupIsOurs(bump.toXDR(), rules()), /fee bump/);
});

test('bytes that are not a transaction are refused, not thrown through', () => {
  assert.throws(() => assertSetupIsOurs('not xdr at all', rules()), ForeignSetup);
});

test('refusing without the facts to check against is a refusal, not a pass', () => {
  assert.throws(() => assertSetupIsOurs(ours('activation'), rules({ funderAddress: null })), ForeignSetup);
  assert.throws(() => assertSetupIsOurs(ours('activation'), rules({ channelAccounts: [] })), ForeignSetup);
  assert.throws(() => assertSetupIsOurs(ours('activation'), rules({ recipient: null })), ForeignSetup);
});
