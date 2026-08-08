import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The page's own record of what it has sent.
 *
 * Kept in the browser rather than asked for, because the watcher knows every
 * transfer it has handled and a "list them" endpoint would be one request from
 * showing everybody's to anybody. A bridge's history is a list of who paid
 * whom.
 */
function withStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return store;
}

const load = async () => {
  withStorage();
  return import(`../../web/history.js?${Math.random()}`);
};

const burn = (txHash, over = {}) => ({
  txHash,
  direction: 'in',
  from: 'base',
  to: 'stellar',
  amount: '5.00',
  ...over,
});

test('the newest is first, because that is the one being waited on', async () => {
  const h = await load();
  h.remember(burn('0xaaa'));
  h.remember(burn('0xbbb'));

  assert.deepEqual(
    h.all().map((e) => e.txHash),
    ['0xbbb', '0xaaa'],
  );
});

/// A retry, a refresh, a second click, the same burn is one transfer.
test('recording the same burn twice leaves one row', async () => {
  const h = await load();
  h.remember(burn('0xaaa', { amount: '5.00' }));
  h.remember(burn('0xaaa', { amount: '9.99' }));

  assert.equal(h.all().length, 1);
  assert.equal(h.all()[0].amount, '9.99', 'and the later one is what is kept');
});

test('a delivery is recorded with what the watcher said', async () => {
  const h = await load();
  h.remember(burn('0xaaa'));
  h.settle('0xaaa', { stellarTxHash: '0xdead' });

  assert.deepEqual(h.all()[0].delivered, { stellarTxHash: '0xdead' });
});

test('settling something it never saw changes nothing', async () => {
  const h = await load();
  h.remember(burn('0xaaa'));
  h.settle('0xzzz', true);

  assert.equal(h.all().length, 1);
  assert.equal(h.all()[0].delivered, undefined);
});

/**
 * Recording is a courtesy. Storage that is full, disabled or corrupt should
 * cost somebody their list and never their transfer.
 */
test('a corrupt record costs the history and not the page', async () => {
  const store = withStorage();
  store.set('stellar-bridge:transfers', '{ this is not json');
  const h = await import(`../../web/history.js?${Math.random()}`);

  assert.deepEqual(h.all(), []);
  assert.doesNotThrow(() => h.remember(burn('0xaaa')));
});

test('storage that refuses does not throw mid-transfer', async () => {
  withStorage();
  globalThis.localStorage.setItem = () => {
    throw new Error('quota');
  };
  const h = await import(`../../web/history.js?${Math.random()}`);

  assert.doesNotThrow(() => h.remember(burn('0xaaa')));
});

test('forgetting removes one and leaves the rest', async () => {
  const h = await load();
  h.remember(burn('0xaaa'));
  h.remember(burn('0xbbb'));
  h.forget('0xaaa');

  assert.deepEqual(
    h.all().map((e) => e.txHash),
    ['0xbbb'],
  );
});
