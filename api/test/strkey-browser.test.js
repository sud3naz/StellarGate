import test from 'node:test';
import assert from 'node:assert/strict';

import { strkeyKind, underlyingAccount, crc16 } from '../../web/strkey.js';

/**
 * The browser copy of the address check, run against the same vectors as the
 * Solidity one in `test/StellarStrkey.t.sol`.
 *
 * Two implementations of a checksum that only agree with themselves prove
 * nothing, and if these two disagree the browser either rejects addresses the
 * contract would take, or waves through ones it would not. Both are bad in
 * their own way, so they are pinned to the same list.
 */

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const GOOD_G = 'GAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB7JZX';
const GOOD_M = 'MAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB6AAAAAAAAAAE2KZ3Q';
const CONTRACT_C = 'CAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB6N4O';
const BAD_CHECKSUM = 'GAAACAQDAQAQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB7JZX';

test('the real mainnet USDC issuer passes, as it does on-chain', () => {
  assert.equal(strkeyKind(USDC_ISSUER), 'account');
});

test('accounts and muxed addresses are told apart', () => {
  assert.equal(strkeyKind(GOOD_G), 'account');
  assert.equal(strkeyKind(GOOD_M), 'muxed');
});

test('a contract address is refused, exactly as the contract refuses it', () => {
  assert.equal(strkeyKind(CONTRACT_C), null);
});

test('a broken checksum is refused', () => {
  assert.equal(strkeyKind(BAD_CHECKSUM), null);
});

test('lengths, alphabet and case are all enforced', () => {
  assert.equal(strkeyKind(''), null);
  assert.equal(strkeyKind(GOOD_G.slice(0, 55)), null);
  assert.equal(strkeyKind(`G0${GOOD_G.slice(2)}`), null, 'no 0 in Stellar’s base32');
  assert.equal(strkeyKind(GOOD_G.toLowerCase()), null);
});

/**
 * 69 characters carry 345 bits where a muxed address is 344, so the last
 * character has a spare bit an encoder leaves at zero. Setting it changes no
 * decoded byte and passes the checksum; only the padding check catches it.
 */
test('non-zero padding is caught, as it is in Solidity', () => {
  assert.equal(strkeyKind(`${GOOD_M.slice(0, 68)}R`), null);
});

test('every single-character typo is rejected', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let checked = 0;

  for (let i = 0; i < GOOD_G.length; i++) {
    for (const char of alphabet) {
      if (char === GOOD_G[i]) continue;
      const typo = GOOD_G.slice(0, i) + char + GOOD_G.slice(i + 1);
      assert.equal(strkeyKind(typo), null, `${typo} slipped through`);
      checked++;
    }
  }

  assert.equal(checked, 56 * 31, 'the whole space, not a sample');
});

test('a muxed address resolves to the account Horizon knows about', () => {
  // Same 32-byte key, so the memo id is the only difference between them.
  assert.equal(underlyingAccount(GOOD_M), GOOD_G);
});

test('an ordinary address resolves to itself', () => {
  assert.equal(underlyingAccount(GOOD_G), GOOD_G);
});

test('the checksum is CRC16-XModem and nothing else', () => {
  // The published check value for this algorithm.
  assert.equal(crc16([...'123456789'].map((c) => c.charCodeAt(0))), 0x31c3);
});
