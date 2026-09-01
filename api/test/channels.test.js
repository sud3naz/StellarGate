import test from 'node:test';
import assert from 'node:assert/strict';

import { Keypair } from '@stellar/stellar-sdk';

import { ChannelPool, NoFreeChannel } from '../src/stellar/channels.js';

const A = 'GAFKBZTURNATMAL6KBLKBOPBRF2WZ4DKPMO6MIAUFIXVQU5EH7CHOZ5Z';
const B = 'GAB4UFSIFR7DQMAUPHFYBXWBWGSDQT3Q3MTQPGMNODG3W5ITNIWJPX2U';
const C = 'GCTKVC77RXFLGZJQSSOIEMKVTNOJ7SFCP2QBZIJ225XY7VY5OXJSW5FV';

const signers = (n) =>
  Array.from({ length: n }, (_, i) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, 10 + i)));

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms) };
}

test('two recipients in flight are given two different channels', () => {
  const pool = new ChannelPool(signers(2), { holdSeconds: 60 });

  const first = pool.reserve(A);
  const second = pool.reserve(B);

  assert.notEqual(first.publicKey(), second.publicKey(), 'one sequence number each');
  assert.equal(pool.busy(), 2);
});

test('the same recipient asking again keeps the channel they had', () => {
  const pool = new ChannelPool(signers(2), { holdSeconds: 60 });

  const first = pool.reserve(A);
  const again = pool.reserve(A);

  assert.equal(again.publicKey(), first.publicKey(), 'a reload is not a second user');
  assert.equal(pool.busy(), 1, 'and it did not take a second channel');
});

test('a pool with nothing left says so rather than handing out a duplicate', () => {
  const pool = new ChannelPool(signers(2), { holdSeconds: 60 });
  pool.reserve(A);
  pool.reserve(B);

  assert.throws(() => pool.reserve(C), NoFreeChannel);
});

test('a submitted setup frees its channel by the account it was sourced from', () => {
  const pool = new ChannelPool(signers(1), { holdSeconds: 60 });
  const channel = pool.reserve(A);

  assert.throws(() => pool.reserve(B), NoFreeChannel);
  pool.releaseAccount(channel.publicKey());

  assert.equal(pool.reserve(B).publicKey(), channel.publicKey());
});

test('a hold expires with the transaction it protected', () => {
  const time = clock();
  const pool = new ChannelPool(signers(1), { holdSeconds: 60, now: time.now });
  const channel = pool.reserve(A);

  time.advance(59 * 1000);
  assert.throws(() => pool.reserve(B), NoFreeChannel, 'still inside the time bound');

  time.advance(2 * 1000);
  assert.equal(pool.reserve(B).publicKey(), channel.publicKey(), 'past it, lent again');
  assert.equal(pool.holder(channel.publicKey()), B);
});

test('releasing a recipient who holds nothing is not an error', () => {
  const pool = new ChannelPool(signers(1), { holdSeconds: 60 });
  pool.release(A);
  pool.releaseAccount('GNOBODY');
  assert.equal(pool.busy(), 0);
});

test('a pool cannot be empty', () => {
  assert.throws(() => new ChannelPool([]), /at least one/);
});
