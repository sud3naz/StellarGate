/**
 * Reading a transaction before signing it.
 *
 * The setup has to be built on the server — a page cannot know the channel
 * account's sequence number — and that means the user is asked to sign
 * something they did not construct. Freighter shows them what it is, which is
 * the real defence, and relies on somebody reading it.
 *
 * This is the defence that does not. The page decodes the envelope it was
 * handed and refuses to pass it on unless every operation drawn on the user's
 * own account is a trustline for the asset we said. A watcher that has been
 * tampered with cannot slip a payment past the page, and the two are worth
 * separating: the API runs on a server somewhere, this file is served from a
 * CDN, and compromising one is not compromising the other.
 *
 * It **fails closed**. An operation type it does not recognise, a
 * precondition it cannot read, a byte left over at the end — all refusals. A
 * parser that guesses at the parts it does not understand is worth less than
 * no parser, because it produces confidence rather than safety.
 *
 * What it cannot do: if this file is itself replaced, nothing here helps.
 * That threat is Freighter's to catch, and the user's.
 */

import { base32Decode } from './strkey.js';

export class SuspiciousSetup extends Error {}

/// The operations a setup is ever allowed to contain.
const CREATE_ACCOUNT = 0;
const PAYMENT = 1;
const CHANGE_TRUST = 6;

const KEY_TYPE_ED25519 = 0;
const ASSET_TYPE_NATIVE = 0;
const ASSET_TYPE_CREDIT_ALPHANUM4 = 1;

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.at = 0;
  }

  take(n) {
    if (this.at + n > this.bytes.length) throw new SuspiciousSetup('the envelope ends early');
    const slice = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return slice;
  }

  u32() {
    const b = this.take(4);
    return ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
  }

  /// XDR has no 64-bit reader in a browser without BigInt gymnastics, and
  /// nothing here needs the value — only to step over it.
  skip64() {
    this.take(8);
  }

  /// Variable-length data is padded out to a four-byte boundary.
  padded(n) {
    const value = this.take(n);
    const slack = (4 - (n % 4)) % 4;
    if (slack) this.take(slack);
    return value;
  }

  done() {
    return this.at === this.bytes.length;
  }
}

/** A `MuxedAccount`: an account id, possibly wrapped with a memo id. */
function readMuxed(r) {
  const type = r.u32();
  if (type === KEY_TYPE_ED25519) return r.take(32);
  if (type === 256) {
    r.skip64(); // the muxed id
    return r.take(32);
  }
  throw new SuspiciousSetup(`unreadable account type ${type}`);
}

/** An `AccountID`: the same thing without the muxing. */
function readAccountId(r) {
  const type = r.u32();
  if (type !== KEY_TYPE_ED25519) throw new SuspiciousSetup(`unreadable key type ${type}`);
  return r.take(32);
}

function readAsset(r) {
  const type = r.u32();
  // XLM itself, which is what the funder sends when it tops an account up.
  if (type === ASSET_TYPE_NATIVE) return { code: 'XLM', native: true, issuer: null };
  if (type !== ASSET_TYPE_CREDIT_ALPHANUM4) {
    // Alphanum12 is a perfectly good asset and simply not what a USDC setup is
    // made of, so seeing one means this is not the transaction we built.
    throw new SuspiciousSetup(`unexpected asset type ${type}`);
  }
  const code = new TextDecoder().decode(r.take(4)).replace(/\0+$/, '');
  return { code, native: false, issuer: readAccountId(r) };
}

function readPreconditions(r) {
  const type = r.u32();
  if (type === 0) return;
  if (type === 1) {
    r.skip64(); // minTime
    r.skip64(); // maxTime
    return;
  }
  throw new SuspiciousSetup(`unreadable preconditions ${type}`);
}

function readMemo(r) {
  const type = r.u32();
  if (type === 0) return;
  if (type === 1) {
    r.padded(r.u32());
    return;
  }
  if (type === 2) {
    r.skip64();
    return;
  }
  if (type === 3 || type === 4) {
    r.take(32);
    return;
  }
  throw new SuspiciousSetup(`unreadable memo ${type}`);
}

function readOperation(r, txSource) {
  const hasSource = r.u32();
  const source = hasSource ? readMuxed(r) : txSource;
  const type = r.u32();

  if (type === CREATE_ACCOUNT) {
    const destination = readAccountId(r);
    r.skip64(); // startingBalance
    return { type: 'createAccount', source, destination };
  }
  if (type === PAYMENT) {
    const destination = readMuxed(r);
    const asset = readAsset(r);
    r.skip64(); // amount
    return { type: 'payment', source, destination, asset };
  }
  if (type === CHANGE_TRUST) {
    const asset = readAsset(r);
    r.skip64(); // limit
    return { type: 'changeTrust', source, asset };
  }
  throw new SuspiciousSetup(`a setup does not contain operation type ${type}`);
}

/**
 * Decodes a transaction envelope far enough to say who is being asked for
 * what. Not a general XDR reader and not trying to be — everything outside
 * the shapes a setup is made of is a refusal.
 */
export function parseEnvelope(base64) {
  const raw = atob(base64);
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const r = new Reader(bytes);

  const envelopeType = r.u32();
  if (envelopeType !== 2) throw new SuspiciousSetup('not a v1 transaction envelope');

  const source = readMuxed(r);
  r.u32(); // fee
  r.skip64(); // sequence number
  readPreconditions(r);
  readMemo(r);

  const count = r.u32();
  if (count > 100) throw new SuspiciousSetup('too many operations');
  const operations = [];
  for (let i = 0; i < count; i += 1) operations.push(readOperation(r, source));

  const ext = r.u32();
  if (ext !== 0) throw new SuspiciousSetup('unreadable transaction extension');

  // Signatures follow; their contents do not matter here, only that the rest
  // of the envelope parses. A trailing byte nobody can account for means the
  // reading was wrong somewhere, and a wrong reading must not pass.
  const signatures = r.u32();
  for (let i = 0; i < signatures; i += 1) {
    r.take(4); // hint
    r.padded(r.u32()); // signature
  }
  if (!r.done()) throw new SuspiciousSetup('the envelope has bytes left over');

  return { source, operations };
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A `G…` address as its raw 32 bytes. */
function accountBytes(address) {
  const decoded = base32Decode(address);
  if (!decoded || decoded.length !== 35) throw new SuspiciousSetup('unreadable address');
  return Uint8Array.from(decoded.slice(1, 33));
}

/**
 * Refuses anything that asks the user for more than a trustline.
 *
 * Operations drawn on other accounts are not checked, and do not need to be:
 * an operation sourced elsewhere cannot move this user's money. What matters
 * is only what is being asked of them.
 *
 * @throws {SuspiciousSetup} with something a person can act on.
 */
export function assertOnlyAskingForTrustline(envelope, { user, assetCode, issuer }) {
  const userBytes = accountBytes(user);
  const issuerBytes = accountBytes(issuer);

  for (const op of envelope.operations) {
    if (!sameBytes(op.source, userBytes)) continue;

    if (op.type !== 'changeTrust') {
      throw new SuspiciousSetup(
        `this transaction asks your account to perform a ${op.type}. ` +
          'A setup only ever adds a trustline. Nothing has been signed.',
      );
    }
    if (op.asset.native || op.asset.code !== assetCode || !sameBytes(op.asset.issuer, issuerBytes)) {
      throw new SuspiciousSetup(
        `this transaction adds a trustline for ${op.asset.code} from an unexpected issuer. ` +
          'Nothing has been signed.',
      );
    }
  }

  return envelope;
}
