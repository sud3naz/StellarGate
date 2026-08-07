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
  };
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
