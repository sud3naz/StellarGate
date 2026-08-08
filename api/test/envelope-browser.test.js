import test from 'node:test';
import assert from 'node:assert/strict';

import { Keypair, Networks, TransactionBuilder, Operation, Account, Asset, Memo } from '@stellar/stellar-sdk';

import { parseEnvelope, assertOnlyAskingForTrustline, SuspiciousSetup } from '../../web/envelope.js';
import { USDC } from '../src/config.js';

/**
 * The parser is checked against envelopes the real SDK built, rather than
 * against ones it built itself. A reader tested on its own output agrees with
 * itself and proves nothing about the bytes Stellar actually produces.
 */
const asset = USDC.testnet;
const passphrase = Networks.TESTNET;

const channel = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const funder = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const user = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
const attacker = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));

const expected = { user: user.publicKey(), assetCode: 'USDC', issuer: asset.getIssuer() };
const builder = () =>
  new TransactionBuilder(new Account(channel.publicKey(), '100'), {
    fee: '10000',
    networkPassphrase: passphrase,
  });

/// atob exists in node 22, which is what makes testing browser code from here
/// honest rather than a translation.
test('the browser parser can be run at all', () => {
  assert.equal(typeof atob, 'function');
});

test('reads the activation a real setup produces', () => {
  const tx = builder()
    .addOperation(
      Operation.createAccount({
        destination: user.publicKey(),
        startingBalance: '3',
        source: funder.publicKey(),
      }),
    )
    .addOperation(Operation.changeTrust({ asset, source: user.publicKey() }))
    .setTimeout(2700)
    .build();
  tx.sign(channel);

  const envelope = parseEnvelope(tx.toXDR());
  assert.deepEqual(
    envelope.operations.map((o) => o.type),
    ['createAccount', 'changeTrust'],
  );
  assert.doesNotThrow(() => assertOnlyAskingForTrustline(envelope, expected));
});

test('reads a top-up, which pays rather than creates', () => {
  const tx = builder()
    .addOperation(
      Operation.payment({
        destination: user.publicKey(),
        asset: Asset.native(),
        amount: '3',
        source: funder.publicKey(),
      }),
    )
    .addOperation(Operation.changeTrust({ asset, source: user.publicKey() }))
    .setTimeout(2700)
    .build();
  tx.sign(channel);

  assert.doesNotThrow(() => assertOnlyAskingForTrustline(parseEnvelope(tx.toXDR()), expected));
});

test('reads a trustline on its own', () => {
  const tx = builder()
    .addOperation(Operation.changeTrust({ asset, source: user.publicKey() }))
    .setTimeout(2700)
    .build();
  tx.sign(channel);

  assert.doesNotThrow(() => assertOnlyAskingForTrustline(parseEnvelope(tx.toXDR()), expected));
});

test('a memo does not confuse it', () => {
  const tx = builder()
    .addOperation(Operation.changeTrust({ asset, source: user.publicKey() }))
    .addMemo(Memo.text('hello'))
    .setTimeout(2700)
    .build();

  assert.doesNotThrow(() => assertOnlyAskingForTrustline(parseEnvelope(tx.toXDR()), expected));
});

// --- the reason this exists ----------------------------------------------

/**
 * A watcher that has been tampered with returns a setup that also empties the
 * account. Freighter would show it; this refuses before Freighter is asked.
 */
test('refuses a payment drawn on the user', () => {
  const tx = builder()
    .addOperation(Operation.changeTrust({ asset, source: user.publicKey() }))
    .addOperation(
      Operation.payment({
        destination: attacker.publicKey(),
        asset,
        amount: '1000',
        source: user.publicKey(),
      }),
    )
    .setTimeout(2700)
    .build();

  assert.throws(
    () => assertOnlyAskingForTrustline(parseEnvelope(tx.toXDR()), expected),
    (e) => e instanceof SuspiciousSetup && /payment/.test(e.message),
  );
});

test('refuses a trustline for somebody else’s USDC', () => {
  const fake = new Asset('USDC', attacker.publicKey());
  const tx = builder()
    .addOperation(Operation.changeTrust({ asset: fake, source: user.publicKey() }))
    .setTimeout(2700)
    .build();

  assert.throws(
    () => assertOnlyAskingForTrustline(parseEnvelope(tx.toXDR()), expected),
    (e) => e instanceof SuspiciousSetup && /issuer/.test(e.message),
  );
});

/**
 * Handing the account over is the quietest way to take it, and it is not a
 * payment, which is exactly why the check is "only ever a trustline" rather
 * than a list of things to watch out for.
 */
test('refuses an operation type a setup never contains', () => {
  const tx = builder()
    .addOperation(
      Operation.setOptions({ masterWeight: 0, source: user.publicKey() }),
    )
    .setTimeout(2700)
    .build();

  assert.throws(() => parseEnvelope(tx.toXDR()), SuspiciousSetup);
});

test('an operation drawn on us is not the user’s problem', () => {
  const tx = builder()
    .addOperation(
      Operation.payment({
        destination: user.publicKey(),
        asset: Asset.native(),
        amount: '3',
        source: funder.publicKey(),
      }),
    )
    .addOperation(Operation.changeTrust({ asset, source: user.publicKey() }))
    .setTimeout(2700)
    .build();

  assert.doesNotThrow(() => assertOnlyAskingForTrustline(parseEnvelope(tx.toXDR()), expected));
});

/**
 * An operation with no source of its own belongs to the transaction's source.
 * If that is the user, it is theirs, and reading it as somebody else's would
 * be exactly the hole this is meant to close.
 */
test('an operation with no source belongs to the transaction source', () => {
  const tx = new TransactionBuilder(new Account(user.publicKey(), '100'), {
    fee: '10000',
    networkPassphrase: passphrase,
  })
    .addOperation(Operation.payment({ destination: attacker.publicKey(), asset, amount: '1000' }))
    .setTimeout(2700)
    .build();

  assert.throws(
    () => assertOnlyAskingForTrustline(parseEnvelope(tx.toXDR()), expected),
    (e) => e instanceof SuspiciousSetup && /payment/.test(e.message),
  );
});

// --- failing closed ------------------------------------------------------

test('refuses bytes that are not an envelope', () => {
  assert.throws(() => parseEnvelope('AAAA'), SuspiciousSetup);
});

test('refuses an envelope with something appended', () => {
  const tx = builder()
    .addOperation(Operation.changeTrust({ asset, source: user.publicKey() }))
    .setTimeout(2700)
    .build();

  const bytes = Uint8Array.from(atob(tx.toXDR()), (c) => c.charCodeAt(0));
  const longer = new Uint8Array(bytes.length + 4);
  longer.set(bytes);
  const tampered = btoa(String.fromCharCode(...longer));

  assert.throws(() => parseEnvelope(tampered), SuspiciousSetup);
});

test('signatures are stepped over without being trusted', () => {
  const tx = builder()
    .addOperation(Operation.changeTrust({ asset, source: user.publicKey() }))
    .setTimeout(2700)
    .build();
  tx.sign(channel, funder);

  const envelope = parseEnvelope(tx.toXDR());
  assert.equal(envelope.operations.length, 1, 'two signatures, still one operation');
});
