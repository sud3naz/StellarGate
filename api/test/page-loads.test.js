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

  // The page keeps its own history here. A shim without it is a browser the
  // page cannot run in, which is the whole thing this test is watching for.
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

const MODULES = [
  'strkey.js',
  'abi.js',
  'chains.js',
  'envelope.js',
  'wallets.js',
  'history.js',
  'app.js',
];

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

/**
 * Nothing about the ends is decided by position any more.
 *
 * The page was written when there was one direction, so which wallet belonged
 * on which side, which chain the balance came from, and what the address field
 * was asking for were all facts rather than questions. Adding the picker made
 * them questions, and every place still answering the old way put an EVM
 * address under "From · Stellar" and read a Base balance for a Stellar
 * account.
 *
 * These are the specific ones that were wrong. A grep is a blunt instrument,
 * but the failure here was a hard-coded word, and that is exactly what a grep
 * is good at.
 */
test('the ends are asked about rather than assumed', () => {
  const source = readFileSync(join(web, 'app.js'), 'utf8');
  const html = readFileSync(join(web, 'index.html'), 'utf8');

  // The address field says which chain it wants, and it is not always the same
  // chain.
  assert.match(source, /destLabel\.textContent = `\$\{CHAINS\[state\.to\]\.name\}/);
  assert.match(source, /qArrives\.textContent = `Arrives on \$\{CHAINS\[state\.to\]\.name\}/);
  assert.match(html, /id="destLabel"/);
  assert.match(html, /id="qArrives"/);

  // Which wallet is shown where follows the direction.
  assert.match(source, /function walletFor\(chainId\)/);
  assert.match(source, /showSide\(el\.fromWho, state\.from\)/);
  assert.match(source, /showSide\(el\.toWho, state\.to\)/);

  // And the balance comes from the chain being spent from.
  assert.match(source, /const source = CHAINS\[state\.from\]/);

  // The connect buttons belong to the ends too. Bound by position, swapping
  // left "Rabby connected" under "From · Stellar" and a Connect button that
  // would have asked for the wallet already in use on the other side.
  assert.match(source, /function connectSide\(side\)/);
  assert.match(source, /\[el\.connectFrom, state\.from\]/);
  assert.match(source, /\[el\.connectTo, state\.to\]/);
  assert.doesNotMatch(source, /el\.connectEvm|el\.connectStellar/, 'nothing is bound to a position');
  assert.match(html, /id="connectFrom"/);
  assert.match(html, /id="connectTo"/);
});

/// Changing either end has to clear an address meant for the other one.
test('a direction change does not carry the old address over', () => {
  const source = readFileSync(join(web, 'app.js'), 'utf8');

  assert.match(source, /function afterDirectionChange\(\)/);
  const body = source.slice(source.indexOf('function afterDirectionChange()'));
  const fn = body.slice(0, body.indexOf('\n}\n'));

  assert.match(fn, /el\.dest\.value = ''/, 'the field is cleared');
  assert.match(fn, /state\.inspection = null/, 'and what was learned about it');
  assert.match(fn, /readBalance\(\)/, 'the balance is on a different chain now');
  assert.match(fn, /renderSides\(\)/, 'and the wallets have swapped sides');
});

/**
 * The address offered as the destination has to be one.
 *
 * Connecting a Stellar wallet filled the field with its `G…` unconditionally,
 * from the days when the Stellar wallet was always the receiving end. Turning
 * the bridge around dropped that into a box asking for an `0x…` and then told
 * the user it was not one.
 */
test('the destination is only prefilled from the wallet receiving it', () => {
  const source = readFileSync(join(web, 'app.js'), 'utf8');

  assert.match(source, /function prefillDestination\(\)/);
  const body = source.slice(source.indexOf('function prefillDestination()'));
  const fn = body.slice(0, body.indexOf('\n}\n'));

  assert.match(fn, /walletFor\(state\.to\)/, 'the receiving end decides, not the wallet');
  assert.match(fn, /if \(el\.dest\.value\) return/, 'and never over something typed');
});
