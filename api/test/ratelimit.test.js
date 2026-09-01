import test from 'node:test';
import assert from 'node:assert/strict';

import { createLimiter, RateLimited } from '../src/ratelimit.js';

function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms) };
}

test('a caller within the limit is let through, and past it is not', () => {
  const time = clock();
  const limiter = createLimiter({ perKey: { limit: 3, windowMs: 60_000 }, now: time.now });

  assert.equal(limiter.take('a').ok, true);
  assert.equal(limiter.take('a').ok, true);
  assert.equal(limiter.take('a').ok, true);

  const refused = limiter.take('a');
  assert.equal(refused.ok, false);
  assert.equal(refused.scope, 'you');
  assert.ok(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= 60);
});

test('one caller’s limit is not another’s', () => {
  const limiter = createLimiter({ perKey: { limit: 1, windowMs: 60_000 } });
  assert.equal(limiter.take('a').ok, true);
  assert.equal(limiter.take('a').ok, false);
  assert.equal(limiter.take('b').ok, true, 'b has not asked before');
});

test('the window slides', () => {
  const time = clock();
  const limiter = createLimiter({ perKey: { limit: 2, windowMs: 10_000 }, now: time.now });

  limiter.take('a');
  time.advance(6_000);
  limiter.take('a');
  assert.equal(limiter.take('a').ok, false);

  time.advance(4_001); // the first hit has aged out, the second has not
  assert.equal(limiter.take('a').ok, true);
  assert.equal(limiter.take('a').ok, false);
});

/**
 * The limit that matters against many addresses: Horizon's budget is for
 * the watcher's address, and a crowd each within their own limit spends it
 * just as surely as one caller in a loop.
 */
test('everybody together has a ceiling of their own', () => {
  const limiter = createLimiter({
    perKey: { limit: 100, windowMs: 60_000 },
    global: { limit: 3, windowMs: 60_000 },
  });

  assert.equal(limiter.take('a').ok, true);
  assert.equal(limiter.take('b').ok, true);
  assert.equal(limiter.take('c').ok, true);

  const refused = limiter.take('d');
  assert.equal(refused.ok, false);
  assert.equal(refused.scope, 'everyone');
});

test('a refusal does not count as a hit', () => {
  const time = clock();
  const limiter = createLimiter({ perKey: { limit: 1, windowMs: 10_000 }, now: time.now });
  limiter.take('a');
  for (let i = 0; i < 50; i += 1) limiter.take('a'); // hammering while refused
  time.advance(10_001);
  assert.equal(limiter.take('a').ok, true, 'the window is measured in hits allowed, not attempts');
});

test('assertAllowed throws with the wait in it', () => {
  const limiter = createLimiter({ perKey: { limit: 1, windowMs: 60_000 } });
  limiter.assertAllowed('a');
  assert.throws(() => limiter.assertAllowed('a', 'the setup'), (error) => {
    assert.ok(error instanceof RateLimited);
    assert.match(error.message, /the setup/);
    assert.ok(error.retryAfterSeconds > 0);
    return true;
  });
});

test('a limiter without a per-caller limit is refused', () => {
  assert.throws(() => createLimiter({}), /per-caller/);
});
