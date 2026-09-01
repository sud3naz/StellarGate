import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandler, listen } from '../src/server.js';
import { Store } from '../src/watcher/store.js';
import { UnpaidBurn } from '../src/watcher/burn.js';

const TX = '0xaf406107764bab3b9e7d12142a1b67eefd9a24898f549ff404ff059cc9b00ec8';
const RECIPIENT = 'GAFKBZTURNATMAL6KBLKBOPBRF2WZ4DKPMO6MIAUFIXVQU5EH7CHOZ5Z';
const OTHER = 'GAB4UFSIFR7DQMAUPHFYBXWBWGSDQT3Q3MTQPGMNODG3W5ITNIWJPX2U';

function harness(verifyBurn) {
  const store = new Store();
  return {
    store,
    handle: createHandler({
      store,
      verifyBurn:
        verifyBurn ??
        (async (txHash, recipient) => {
          if (recipient !== RECIPIENT) {
            throw new UnpaidBurn(`burn ${txHash} paid for ${RECIPIENT}, not ${recipient}`);
          }
          return { txHash, stellarRecipient: RECIPIENT, activate: true };
        }),
    }),
  };
}

const post = (body) => ({ method: 'POST', path: '/transfers', body });

test('takes the setup the browser is the only source of', async () => {
  const { store, handle } = harness();

  const result = await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' }));

  assert.equal(result.status, 200);
  assert.equal(result.body.hasSetup, true);
  assert.equal(store.get(TX).setupXdr, 'XDR');
});

test('a transfer needs both a burn and a recipient', async () => {
  const { handle } = harness();
  assert.equal((await handle(post({ txHash: TX }))).status, 400);
  assert.equal((await handle(post({ recipient: RECIPIENT }))).status, 400);
});

/**
 * The griefing vector this endpoint exists to not have. `remember` refuses one
 * burn against two addresses, so whoever files first wins, and anyone can
 * read a transaction hash off the chain. Verifying before recording means a
 * recipient the burn does not name is never written down at all.
 */
test('a burn cannot be filed against an address it did not pay', async () => {
  const { store, handle } = harness();

  const result = await handle(post({ txHash: TX, recipient: OTHER, setupXdr: 'XDR' }));

  assert.equal(result.status, 400);
  assert.equal(store.get(TX), null, 'nothing was written, so the real one is not locked out');

  const real = await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' }));
  assert.equal(real.status, 200, 'and it can still be filed correctly afterwards');
});

/**
 * The browser posts within a second of burning, and the receipt may not be
 * visible yet. That is a "come back", not a refusal, and recording it now
 * would mean recording something unverified.
 */
test('a burn the chain has not shown yet is answered with come back', async () => {
  const { store, handle } = harness(async () => null);

  const result = await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' }));

  assert.equal(result.status, 202);
  assert.equal(result.body.retry, true);
  assert.equal(store.get(TX), null);
});

test('posting the same transfer twice is not an error', async () => {
  const { handle } = harness();
  await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' }));

  const again = await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' }));
  assert.equal(again.status, 200);
});

/// The follower records the burn from the log; the browser brings the setup
/// afterwards. Both orders have to work.
test('a setup arriving after the log is filled in', async () => {
  const { store, handle } = harness();
  store.remember({ txHash: TX, recipient: RECIPIENT });

  const result = await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' }));

  assert.equal(result.body.hasSetup, true);
  assert.equal(store.get(TX).setupXdr, 'XDR');
});

// --- reading state back ---------------------------------------------------

test('an unknown transfer is a 404, not an empty answer', async () => {
  const { handle } = harness();
  assert.equal((await handle({ method: 'GET', path: `/transfers/${TX}` })).status, 404);
});

test('progress is readable without exposing the signed setup', async () => {
  const { store, handle } = harness();
  await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' }));
  store.markDelivered(TX, 'stellar-hash');

  const result = await handle({ method: 'GET', path: `/transfers/${TX}` });

  assert.equal(result.status, 200);
  assert.equal(result.body.delivered, true);
  assert.equal(result.body.hasSetup, true);
  assert.equal(result.body.setupXdr, undefined, 'a signed transaction is not status');
});

test('health reports the queue', async () => {
  const { store, handle } = harness();
  store.remember({ txHash: TX, recipient: RECIPIENT });

  const result = await handle({ method: 'GET', path: '/health' });
  assert.equal(result.body.pending, 1);
});

test('an unknown route is refused', async () => {
  const { handle } = harness();
  assert.equal((await handle({ method: 'GET', path: '/whatever' })).status, 404);
});

// --- letting the page talk to it ------------------------------------------

/**
 * The page and the watcher are never the same origin. However this is
 * arranged, a static host and a service, or two ports on one laptop, the
 * browser asks permission first and refuses everything without it.
 */
test('a preflight is answered rather than looked up as a route', async () => {
  const answered = [];
  const fakeServer = {
    listen() {},
  };
  const created = (handler) => {
    fakeServer.handler = handler;
    return fakeServer;
  };

  const { handle } = harness();
  listen(handle, { port: 0, createServer: created });

  const res = {
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    writeHead(status) {
      answered.push(status);
      return this;
    },
    end() {},
  };
  await fakeServer.handler({ method: 'OPTIONS', url: '/setup', [Symbol.asyncIterator]: async function* () {} }, res);

  assert.deepEqual(answered, [204], 'a 404 here refuses the request that follows');
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.match(res.headers['access-control-allow-headers'], /content-type/);
});

// --- channels and dropped setups --------------------------------------------

test('a pool with no free channel is a 503 with an invitation, not a refusal', async () => {
  const { NoFreeChannel } = await import('../src/stellar/channels.js');
  const handle = createHandler({
    store: new Store(),
    verifyBurn: async () => null,
    buildSetup: async () => {
      throw new NoFreeChannel('all 2 channel accounts are busy');
    },
  });

  const result = await handle({ method: 'POST', path: '/setup', body: { recipient: RECIPIENT } });

  assert.equal(result.status, 503);
  assert.equal(result.body.retry, true);
  assert.match(result.body.error, /busy/);
});

test('a dropped setup is visible, so the page can ask for another', async () => {
  const { store, handle } = harness();
  await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' }));
  store.dropSetup(TX, 'tx_bad_seq');

  const before = await handle({ method: 'GET', path: `/transfers/${TX}` });
  assert.equal(before.body.hasSetup, false);
  assert.equal(before.body.setupFailure.reason, 'tx_bad_seq');

  // The replacement is taken through the same door as the first.
  const posted = await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR-2' }));
  assert.equal(posted.status, 200);
  assert.equal(posted.body.hasSetup, true);

  const after = await handle({ method: 'GET', path: `/transfers/${TX}` });
  assert.equal(after.body.setupFailure, null);
  assert.equal(store.get(TX).setupXdr, 'XDR-2');
});

// --- the door checks the envelope ------------------------------------------

test('a setup this server did not build is refused at the door, with the reason', async () => {
  const { ForeignSetup } = await import('../src/stellar/verify.js');
  const store = new Store();
  const handle = createHandler({
    store,
    verifyBurn: async () => ({ txHash: TX, stellarRecipient: RECIPIENT, activate: true }),
    verifySetup: (xdr) => {
      if (xdr !== 'OURS') throw new ForeignSetup('refusing to sign this setup: it pays the wrong person');
    },
  });

  const refused = await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'THEIRS' }));
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /wrong person/);
  assert.equal(store.get(TX), null, 'nothing was written down');

  const taken = await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'OURS' }));
  assert.equal(taken.status, 200);
  assert.equal(store.get(TX).setupXdr, 'OURS');
});

// --- the rate limit ---------------------------------------------------------

test('the costly routes are rate limited per caller, and say when to come back', async () => {
  const { createLimiter } = await import('../src/ratelimit.js');
  const { handle } = harness(async () => null);
  const limited = createHandler({
    store: new Store(),
    verifyBurn: async () => null,
    buildSetup: async () => null,
    limiter: createLimiter({ perKey: { limit: 2, windowMs: 60_000 } }),
  });

  const ask = (ip) => limited({ method: 'POST', path: '/setup', body: { recipient: RECIPIENT }, ip });

  assert.equal((await ask('1.1.1.1')).status, 200);
  assert.equal((await ask('1.1.1.1')).status, 200);
  const refused = await ask('1.1.1.1');
  assert.equal(refused.status, 429);
  assert.equal(refused.body.retry, true);
  assert.ok(refused.body.retryAfterSeconds > 0);

  assert.equal((await ask('2.2.2.2')).status, 200, 'somebody else is not punished for it');
  assert.equal((await limited({ method: 'GET', path: '/health', ip: '1.1.1.1' })).status, 200, 'reads are free');
  void handle;
});

test('the caller is read from the proxy header, first entry, only when the proxy is trusted', async () => {
  const { callerAddress } = await import('../src/server.js');
  const req = { headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };

  assert.equal(callerAddress(req), '9.9.9.9');
  assert.equal(callerAddress(req, { trustProxy: false }), '127.0.0.1');
  assert.equal(callerAddress({ headers: {}, socket: { remoteAddress: '5.5.5.5' } }), '5.5.5.5');
});

test('progress does not say who the money went to', async () => {
  const { handle } = harness();
  await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' }));
  const result = await handle({ method: 'GET', path: `/transfers/${TX}` });
  assert.equal(result.body.recipient, undefined, 'a hash is public; the address behind it is not');
});
