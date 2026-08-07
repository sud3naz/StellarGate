import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_SELECTOR,
  APPROVE_SELECTOR,
  encodeApprove,
  encodeBridge,
} from '../../web/abi.js';

/**
 * Vectors from `cast calldata`, so the browser's hand-encoding is checked
 * against something that computes it from the signature rather than against a
 * copy of itself. A wrong selector is four bytes that look perfectly fine and
 * revert on chain; the first version of this shipped one.
 *
 * $ cast calldata "bridge(uint256,string,bool,uint256)" \
 *     4500000 "GAFKBZTU…OZ5Z" true 3000000
 */
const RECIPIENT = 'GAFKBZTURNATMAL6KBLKBOPBRF2WZ4DKPMO6MIAUFIXVQU5EH7CHOZ5Z';

const CAST_BRIDGE =
  '0x70a8909d' +
  '000000000000000000000000000000000000000000000000000000000044aa20' +
  '0000000000000000000000000000000000000000000000000000000000000080' +
  '0000000000000000000000000000000000000000000000000000000000000001' +
  '00000000000000000000000000000000000000000000000000000000002dc6c0' +
  '0000000000000000000000000000000000000000000000000000000000000038' +
  '4741464b425a5455524e41544d414c364b424c4b424f5042524632575a34444b' +
  '504d4f364d4941554649585651553545483743484f5a355a0000000000000000';

test('the bridge call matches what cast computes from the signature', () => {
  assert.equal(encodeBridge(4_500_000n, RECIPIENT, true, 3_000_000n), CAST_BRIDGE);
});

test('the selectors are the ones the contract answers to', () => {
  assert.equal(BRIDGE_SELECTOR, '0x70a8909d');
  assert.equal(APPROVE_SELECTOR, '0x095ea7b3');
});

test('an approve is the standard one', () => {
  const encoded = encodeApprove('0x69752D7C3d1c7C919bc24e34cD440762F642FF00', 4_500_000n);
  assert.equal(
    encoded,
    '0x095ea7b3' +
      '00000000000000000000000069752d7c3d1c7c919bc24e34cd440762f642ff00' +
      '000000000000000000000000000000000000000000000000000000000044aa20',
  );
});

/**
 * The offset is the part that would fail quietly: point it at the wrong word
 * and the calldata still decodes, just to a different address. The contract
 * checks the checksum of what it is handed, not of what was meant.
 */
test('the recipient decodes back out of its own encoding', () => {
  const encoded = encodeBridge(1_000_000n, RECIPIENT, false, 0n);
  const body = encoded.slice(10);
  const offset = Number(BigInt(`0x${body.slice(64, 128)}`));
  const lengthAt = offset * 2;
  const length = Number(BigInt(`0x${body.slice(lengthAt, lengthAt + 64)}`));
  const text = Buffer.from(body.slice(lengthAt + 64, lengthAt + 64 + length * 2), 'hex').toString();

  assert.equal(text, RECIPIENT);
});

test('activation off is a zero and not an absence', () => {
  const encoded = encodeBridge(1_000_000n, RECIPIENT, false, 0n);
  const activateWord = encoded.slice(10).slice(128, 192);
  assert.equal(BigInt(`0x${activateWord}`), 0n);
});
