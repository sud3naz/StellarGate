import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';

import { parseEnvelope, assertBurnsYourOwnUsdc, SuspiciousSetup } from '../../web/envelope.js';

/**
 * The outbound guard, against envelopes the real SDK built.
 *
 * The inbound setup has had this since the beginning; going out, the page took
 * whatever XDR the watcher returned and passed it straight to Freighter.
 * Freighter draws a Soroban invocation as a contract id and a row of encoded
 * arguments, so "check it before you sign" was advice nobody could act on, and
 * a watcher that had been tampered with could have returned a call moving the
 * user's whole balance and looked no different.
 *
 * Every case below is a transaction somebody could actually be handed.
 */

const user = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
const attacker = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
const CONTRACT = 'CCWMXUFXXYL6HEL4BYXRPLUXPGI2DEYEOP7TZX7EXWZBOM7WAWWDMWHR';
const OTHER_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const RECIPIENT = '0x236407FdA32b95CD5456743753f29B141EB2611A';
/// 1.234567 USDC. Stellar carries seven decimals, the EVM side carries six.
const AMOUNT = 12_345_670n;

const passphrase = Networks.TESTNET;
const expected = { user: user.publicKey(), contractId: CONTRACT, amount: AMOUNT, recipient: RECIPIENT };

const evmBytes = (address) => Buffer.from(address.slice(2), 'hex');

function burn({
  source = user.publicKey(),
  contractId = CONTRACT,
  fn = 'bridge',
  from = user.publicKey(),
  amount = AMOUNT,
  recipient = RECIPIENT,
  fee = '1000000',
  extraOps = [],
  args = null,
} = {}) {
  const builder = new TransactionBuilder(new Account(source, '123456789'), {
    fee,
    networkPassphrase: passphrase,
  }).addOperation(
    new Contract(contractId).call(
      fn,
      ...(args ?? [
        new Address(from).toScVal(),
        nativeToScVal(BigInt(amount), { type: 'i128' }),
        nativeToScVal(evmBytes(recipient), { type: 'bytes' }),
      ]),
    ),
  );
  for (const op of extraOps) builder.addOperation(op);
  return builder.setTimeout(300).build().toXDR();
}

/** What prepareTransaction does to an envelope: attaches the footprint. */
function withSorobanData(base64) {
  const tx = TransactionBuilder.fromXDR(base64, passphrase);
  return TransactionBuilder.cloneFrom(tx)
    .setSorobanData(
      new xdr.SorobanTransactionData({
        ext: new xdr.SorobanTransactionDataExt(0),
        resources: new xdr.SorobanResources({
          footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
          instructions: 1000,
          diskReadBytes: 100,
          writeBytes: 100,
        }),
        resourceFee: xdr.Int64.fromString('12345'),
      }),
    )
    .build()
    .toXDR();
}

test('the burn the user asked for is read and allowed', () => {
  const envelope = parseEnvelope(burn());
  assert.equal(envelope.operations.length, 1);
  assert.equal(envelope.operations[0].fn, 'bridge');
  assert.equal(envelope.operations[0].args[1].value, AMOUNT);
  assertBurnsYourOwnUsdc(envelope, expected);
});

test('a prepared transaction still reads, footprint and all', () => {
  // The real one always arrives prepared. Refusing it because of the resource
  // data in the extension would mean refusing every genuine burn.
  const envelope = parseEnvelope(withSorobanData(burn()));
  assert.equal(envelope.unread, 'the resource footprint');
  assert.equal(envelope.fee, 1_012_345, 'the resource fee is inside the transaction fee');
  assertBurnsYourOwnUsdc(envelope, expected);
});

test('an amount other than the one entered is refused', () => {
  // The obvious tampering: same everything, more money.
  const envelope = parseEnvelope(burn({ amount: 999_999_999n }));
  assert.throws(() => assertBurnsYourOwnUsdc(envelope, expected), SuspiciousSetup);
});

test('a different recipient is refused', () => {
  const envelope = parseEnvelope(burn({ recipient: `0x${'11'.repeat(20)}` }));
  assert.throws(
    () => assertBurnsYourOwnUsdc(envelope, expected),
    /deliver to a different address/,
  );
});

test('a call to some other contract is refused', () => {
  const envelope = parseEnvelope(burn({ contractId: OTHER_CONTRACT }));
  assert.throws(() => assertBurnsYourOwnUsdc(envelope, expected), /not the bridge/);
});

test('a different function on the right contract is refused', () => {
  // The contract may well have a `transfer`. Being the right contract is not
  // enough on its own.
  const envelope = parseEnvelope(burn({ fn: 'transfer' }));
  assert.throws(() => assertBurnsYourOwnUsdc(envelope, expected), /calls transfer/);
});

test('taking the money from somebody else is refused', () => {
  // Signed by the user, spending an account they do not own. It would fail on
  // chain, and it should never reach a wallet.
  const envelope = parseEnvelope(burn({ from: attacker.publicKey() }));
  assert.throws(() => assertBurnsYourOwnUsdc(envelope, expected), /not yours/);
});

test('a transaction drawn on another account is refused', () => {
  const envelope = parseEnvelope(burn({ source: attacker.publicKey(), from: attacker.publicKey() }));
  assert.throws(() => assertBurnsYourOwnUsdc(envelope, expected), /drawn on an account/);
});

test('a second operation smuggled in beside the burn is refused', () => {
  // The burn itself is perfect. The payment underneath it is the attack, and
  // checking only the first operation would have waved it through.
  const envelope = parseEnvelope(
    burn({
      extraOps: [
        Operation.payment({
          destination: attacker.publicKey(),
          asset: Asset.native(),
          amount: '100',
        }),
      ],
    }),
  );
  assert.throws(() => assertBurnsYourOwnUsdc(envelope, expected), /2 operations/);
});

test('an outrageous fee is refused', () => {
  // A tampered watcher cannot drain XLM through the resource fee either: the
  // transaction fee has to cover it, and the transaction fee is read.
  const envelope = parseEnvelope(burn({ fee: '900000000' }));
  assert.throws(() => assertBurnsYourOwnUsdc(envelope, expected), /in fees/);
});

test('arguments in the wrong shape are refused rather than guessed at', () => {
  // A parser that skipped an argument type it did not know would lose its
  // place and read the amount out of the middle of something else.
  const envelope = () =>
    parseEnvelope(
      burn({
        args: [
          new Address(user.publicKey()).toScVal(),
          nativeToScVal(AMOUNT, { type: 'i128' }),
          nativeToScVal('not-bytes', { type: 'string' }),
        ],
      }),
    );
  assert.throws(envelope, SuspiciousSetup);
});

test('the wrong number of arguments is refused', () => {
  const envelope = parseEnvelope(
    burn({ args: [new Address(user.publicKey()).toScVal(), nativeToScVal(AMOUNT, { type: 'i128' })] }),
  );
  assert.throws(() => assertBurnsYourOwnUsdc(envelope, expected), /two arguments|arguments rather than three/);
});
