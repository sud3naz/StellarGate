import test from 'node:test';
import assert from 'node:assert/strict';

import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

import { buildSetupFor } from '../src/stellar/setup.js';
import { submit, spendsOurXlm } from '../src/stellar/activation.js';
import { USDC } from '../src/config.js';

const asset = USDC.testnet;
const passphrase = Networks.TESTNET;

const channelKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const funderKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const userKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));

const LEDGERS = { _embedded: { records: [{ base_reserve_in_stroops: 5_000_000 }] } };

/** Horizon answering for the destination, the reserve, and the channel. */
function horizonWith(destination) {
  return async (url) => {
    if (url.includes('/ledgers')) return { ok: true, status: 200, json: async () => LEDGERS };
    if (url.includes(channelKey.publicKey())) {
      return { ok: true, status: 200, json: async () => ({ sequence: '100' }) };
    }
    if (destination === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => destination };
  };
}

const options = (fetchImpl) => ({
  horizon: 'https://horizon.example',
  asset,
  networkPassphrase: passphrase,
  channelSigner: channelKey,
  funderAddress: funderKey.publicKey(),
  fetchImpl,
});

const READY = {
  balances: [
    { asset_type: 'native', balance: '100' },
    { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: asset.getIssuer(), balance: '0', limit: '1000', is_authorized: true },
  ],
  subentry_count: 1,
};

const NO_TRUSTLINE_RICH = {
  balances: [{ asset_type: 'native', balance: '100' }],
  subentry_count: 0,
};

/// Exists, but 1.2 XLM is short of the reserve plus a trustline.
const NO_TRUSTLINE_POOR = {
  balances: [{ asset_type: 'native', balance: '1.2' }],
  subentry_count: 0,
};

test('an address that needs nothing gets nothing to sign', async () => {
  const built = await buildSetupFor(userKey.publicKey(), options(horizonWith(READY)));
  assert.equal(built, null);
});

test('an address with no account gets an activation', async () => {
  const built = await buildSetupFor(userKey.publicKey(), options(horizonWith(null)));

  assert.equal(built.needed, 'activation');
  assert.equal(built.fundsUser, true);

  const tx = TransactionBuilder.fromXDR(built.xdr, passphrase);
  assert.deepEqual(tx.operations.map((o) => o.type), ['createAccount', 'changeTrust']);
});

/**
 * The distinctive one. An account that exists but cannot afford its own
 * trustline reserve is in the same position as one that does not exist, it
 * cannot hold USDC and cannot fix that, so it gets the same three XLM and
 * pays the same fee. Only the operation differs.
 */
test('an account too poor for its own trustline is topped up, not left', async () => {
  const built = await buildSetupFor(userKey.publicKey(), options(horizonWith(NO_TRUSTLINE_POOR)));

  assert.equal(built.needed, 'topup');
  assert.equal(built.fundsUser, true);

  const tx = TransactionBuilder.fromXDR(built.xdr, passphrase);
  assert.deepEqual(tx.operations.map((o) => o.type), ['payment', 'changeTrust']);
});

test('an account that can pay its own reserve is only asked for a trustline', async () => {
  const built = await buildSetupFor(userKey.publicKey(), options(horizonWith(NO_TRUSTLINE_RICH)));

  assert.equal(built.needed, 'trustline');
  assert.equal(built.fundsUser, false, 'nothing of ours is at stake');

  const tx = TransactionBuilder.fromXDR(built.xdr, passphrase);
  assert.deepEqual(tx.operations.map((o) => o.type), ['changeTrust']);
});

// --- the signature that is deliberately missing --------------------------

/**
 * The attack this shape exists to close. If what went back to the browser
 * carried the funder's signature, the user could skip the burn entirely and
 * submit it themselves: three XLM, once per request, for free. So the funder
 * signs on the far side of the proof and what leaves here cannot create an
 * account on its own.
 */
test('what the browser is given cannot create an account by itself', async () => {
  const built = await buildSetupFor(userKey.publicKey(), options(horizonWith(null)));
  const tx = TransactionBuilder.fromXDR(built.xdr, passphrase);

  const signers = tx.signatures.map((s) => s.hint().toString('hex'));
  const channelHint = channelKey.signatureHint().toString('hex');
  const funderHint = funderKey.signatureHint().toString('hex');

  assert.ok(signers.includes(channelHint), 'the channel signs, because it owns the sequence');
  assert.equal(signers.includes(funderHint), false, 'the funder does not, and that is the point');
});

test('the funder signs at submission, and only with a proof', async () => {
  const built = await buildSetupFor(userKey.publicKey(), options(horizonWith(null)));

  const signed = TransactionBuilder.fromXDR(built.xdr, passphrase);
  signed.sign(userKey);
  const heldXdr = signed.toXDR();

  assert.equal(spendsOurXlm(heldXdr, passphrase), true);

  // Without the funder there is nothing to submit with.
  await assert.rejects(
    submit('https://horizon.example', heldXdr, {
      networkPassphrase: passphrase,
      paidBurn: { txHash: '0xaf40', activate: true },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ hash: 'x' }) }),
    }),
    /funder/,
  );

  // With it, the transaction that goes out carries all three signatures.
  let posted = null;
  const result = await submit('https://horizon.example', heldXdr, {
    networkPassphrase: passphrase,
    paidBurn: { txHash: '0xaf40', activate: true },
    funderSigner: funderKey,
    fetchImpl: async (_url, init) => {
      posted = new URLSearchParams(init.body).get('tx');
      return { ok: true, status: 200, json: async () => ({ hash: 'abc' }) };
    },
  });

  assert.equal(result.ok, true);
  const sent = TransactionBuilder.fromXDR(posted, passphrase);
  assert.equal(sent.signatures.length, 3, 'channel, user, and now the funder');
});

/// And no proof still means no signature, however the request is dressed up.
test('no proof means the funder never signs', async () => {
  const built = await buildSetupFor(userKey.publicKey(), options(horizonWith(null)));
  const signed = TransactionBuilder.fromXDR(built.xdr, passphrase);
  signed.sign(userKey);

  await assert.rejects(
    submit('https://horizon.example', signed.toXDR(), {
      networkPassphrase: passphrase,
      funderSigner: funderKey,
      fetchImpl: async () => {
        throw new Error('Horizon must not be reached');
      },
    }),
  );
});
