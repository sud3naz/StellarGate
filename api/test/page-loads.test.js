import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const web = join(dirname(fileURLToPath(import.meta.url)), '../../web');

/**
 * Does the page's module graph load at all.
 *
 * This exists because it once did not, and nothing caught it. An edit removed
 * a function that another module imported by name; the file stayed
 * syntactically perfect, `node --check` passed on every file, and the whole
 * of `app.js` failed to evaluate in the browser. The page rendered its static
 * HTML and did nothing — empty dropdowns, dead buttons — which looks like a
 * styling problem and is not one.
 *
 * A missing export is a link between two files, so no single file can be
 * checked for it. Only loading them together can.
 */

/** Enough of a browser for a module to reach the end of its top level. */
function shimBrowser() {
  const element = () => ({
    innerHTML: '',
    textContent: '',
    value: '',
    hidden: true,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    append() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
  });

  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    // The page reads this to work out where its watcher is, so a shim without
    // it is a browser the page cannot run in.
    location: { protocol: 'https:', hostname: 'example.test', search: '' },
  };
  globalThis.location = globalThis.window.location;
  globalThis.document = {
    getElementById: () => element(),
    createElement: () => element(),
    addEventListener() {},
  };
  globalThis.Event = class {};
  globalThis.TextEncoder = TextEncoder;
}

const MODULES = ['strkey.js', 'abi.js', 'chains.js', 'envelope.js', 'wallets.js', 'app.js'];

test('every module the page loads can be loaded', async () => {
  shimBrowser();

  for (const name of MODULES) {
    await assert.doesNotReject(
      () => import(join(web, name)),
      `${name} did not load; the page would be a static document`,
    );
  }
});

/**
 * The names one module reaches for have to be the names another provides.
 * This is the specific failure above, stated as a rule.
 */
test('nothing is imported that is not exported', async () => {
  shimBrowser();

  for (const name of MODULES) {
    const source = readFileSync(join(web, name), 'utf8');
    const imports = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([^']+)'/g)];

    for (const [, names, from] of imports) {
      const provider = await import(join(web, from));
      for (const wanted of names.split(',').map((n) => n.trim()).filter(Boolean)) {
        assert.ok(
          wanted in provider,
          `${name} imports ${wanted} from ${from}, which does not export it`,
        );
      }
    }
  }
});

/// The page is a list of files a browser has to be able to fetch.
test('the page asks for nothing that is not there', () => {
  const html = readFileSync(join(web, 'index.html'), 'utf8');
  const referenced = [...html.matchAll(/src="([^"]+\.js)"/g)].map(([, src]) => src);

  assert.ok(referenced.includes('app.js'));
  for (const src of referenced) {
    assert.doesNotThrow(() => readFileSync(join(web, src)), `${src} is referenced and missing`);
  }
});

/**
 * Every `setStatus` call names something that exists.
 *
 * Fifteen of them did not. `setStatus` read a table and took one argument;
 * the calls passed a kind and a sentence, so the lookup returned undefined
 * and destructuring it threw on the first line of every transfer. The button
 * worked perfectly and the work behind it never started.
 *
 * A call site is not a file, so loading the modules does not catch this — the
 * throw only happens when somebody clicks. Reading the calls does.
 */
test('setStatus is only ever asked for a status it has', () => {
  const source = readFileSync(join(web, 'app.js'), 'utf8');

  const known = new Set();
  for (const table of ['STATUS', 'KINDS']) {
    const block = source.slice(source.indexOf(`const ${table} = {`));
    const body = block.slice(0, block.indexOf('\n};'));
    for (const [, key] of body.matchAll(/^\s{2}(\w+):/gm)) known.add(key);
  }

  assert.ok(known.size > 5, 'the tables were not found where this expects them');

  const calls = [...source.matchAll(/setStatus\(\s*'(\w+)'/g)].map(([, key]) => key);
  assert.ok(calls.length > 5, 'no calls found; this test has stopped watching anything');

  for (const key of new Set(calls)) {
    assert.ok(known.has(key), `setStatus('${key}') names a status that does not exist`);
  }
});

/**
 * The watcher's address comes from the page's own origin, never from the URL.
 *
 * This page signs whatever transaction that origin hands back, so a `?api=`
 * override would let somebody send a link to the real page with a hostile
 * watcher behind it and have a wallet asked to sign whatever it liked. The
 * origin the page was served from carries no such invitation — anyone who can
 * change it is already serving the page.
 */
test('the watcher address is never taken from the URL', () => {
  const source = readFileSync(join(web, 'app.js'), 'utf8');

  assert.doesNotMatch(source, /searchParams/, 'the page must not read its own query string');
  assert.doesNotMatch(source, /location\.search/, 'the page must not read its own query string');
  assert.match(source, /function watcherOrigin/, 'it is derived, and here is where');
});

/**
 * The quote and the burn ask the same question the same way.
 *
 * They did not. The quote read `fundsUser` — true only when our XLM is
 * actually going to be spent — and the burn read `needs !== 'nothing'`, which
 * is also true for an account that exists and can pay its own trustline
 * reserve. So a destination holding ten thousand XLM was shown "Account
 * activation 0.00" and charged three dollars for an activation it did not
 * need and did not receive.
 *
 * Both expressions were valid JavaScript, both modules loaded, every status
 * key existed. Nothing about either line was wrong on its own — only that
 * there were two of them.
 */
test('the quote and the burn agree on who needs activating', () => {
  const source = readFileSync(join(web, 'app.js'), 'utf8');

  const ways = [...source.matchAll(/const activate = ([^;]+);/g)].map(([, expr]) =>
    expr.replace(/\s+/g, ' ').trim(),
  );

  assert.ok(ways.length >= 2, 'both the quote and the burn should be deciding this');
  assert.equal(
    new Set(ways).size,
    1,
    `activation is decided ${new Set(ways).size} ways: ${[...new Set(ways)].join('  |  ')}`,
  );
});
