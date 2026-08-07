/**
 * Stellar addresses in the browser, checked the same way the contract checks
 * them: base32, then the CRC16 the strkey carries.
 *
 * This is the copy that can be bypassed — the one in {StellarStrkey} is not —
 * but it is the one that stops a typo before the user has signed anything, so
 * it has to agree with the contract exactly. The tests run both against the
 * same vectors.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(text) {
  let buffer = 0;
  let bits = 0;
  const out = [];
  for (const char of text) {
    const value = B32.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  // The trailing bits of the last character are not payload, and an encoder
  // always leaves them zero.
  return buffer === 0 ? out : null;
}

export function base32Encode(bytes) {
  let buffer = 0;
  let bits = 0;
  let out = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out;
}

/** CRC16-XModem: polynomial 0x1021, zero init, no reflection, no final xor. */
export function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export const VERSION_ACCOUNT = 0x30; // G…
export const VERSION_MUXED = 0x60; // M…

/**
 * @returns {'account'|'muxed'|null} null for anything that cannot receive a
 * payment, contract addresses included.
 */
export function strkeyKind(text) {
  const expected = text.length === 56 ? 35 : text.length === 69 ? 43 : 0;
  if (!expected) return null;

  const decoded = base32Decode(text);
  if (!decoded || decoded.length !== expected) return null;

  const version = decoded[0];
  if (version === VERSION_ACCOUNT && expected !== 35) return null;
  if (version === VERSION_MUXED && expected !== 43) return null;
  if (version !== VERSION_ACCOUNT && version !== VERSION_MUXED) return null;

  const checksum = decoded[expected - 2] | (decoded[expected - 1] << 8);
  return crc16(decoded.slice(0, expected - 2)) === checksum
    ? version === VERSION_ACCOUNT
      ? 'account'
      : 'muxed'
    : null;
}

/**
 * The account a muxed address sits on top of. Horizon knows nothing about the
 * memo id folded into an `M…`, so anything asking it about a balance has to
 * ask about this instead.
 */
export function underlyingAccount(text) {
  if (strkeyKind(text) !== 'muxed') return text;
  const decoded = base32Decode(text);
  const body = [VERSION_ACCOUNT, ...decoded.slice(1, 33)];
  const sum = crc16(body);
  return base32Encode([...body, sum & 0xff, (sum >> 8) & 0xff]);
}
