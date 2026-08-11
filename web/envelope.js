/**
 * Reading a transaction before signing it.
 *
 * The setup has to be built on the server, a page cannot know the channel
 * account's sequence number, and that means the user is asked to sign
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
 * precondition it cannot read, a byte left over at the end, all refusals. A
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

/// Going the other way, the user signs a Soroban invocation instead. Every
/// number below was read out of @stellar/stellar-sdk's own xdr enums rather
/// than from memory, because a parser built on a misremembered discriminant
/// is a parser that waves the wrong transaction through.
const INVOKE_HOST_FUNCTION = 24;
const HOST_FUNCTION_INVOKE_CONTRACT = 0;
const SCV_I128 = 10;
const SCV_BYTES = 13;
const SCV_ADDRESS = 18;
const SC_ADDRESS_ACCOUNT = 0;
const SC_ADDRESS_CONTRACT = 1;
/// The version byte on a `C…` strkey, as `0x30` is on a `G…`.
const VERSION_CONTRACT = 0x10;

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.at = 0;
    /// Set when a reader has gone as far as it can safely go, so the caller
    /// knows the remaining bytes were left unread on purpose rather than by
    /// a parser that lost its place.
    this.stopped = null;
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
  /// most of what is read here needs to be stepped over rather than known.
  skip64() {
    this.take(8);
  }

  /// The outbound burn is the exception: its amount is the whole point of
  /// checking, so it has to come out as a number and not as eight ignored
  /// bytes. Big-endian, like everything else in XDR.
  u64() {
    const b = this.take(8);
    let value = 0n;
    for (const byte of b) value = (value << 8n) | BigInt(byte);
    return value;
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

/** An `SCAddress`: either a `G…` account or a `C…` contract. */
function readScAddress(r) {
  const type = r.u32();
  if (type === SC_ADDRESS_ACCOUNT) return { kind: 'account', bytes: readAccountId(r) };
  if (type === SC_ADDRESS_CONTRACT) return { kind: 'contract', bytes: r.take(32) };
  throw new SuspiciousSetup(`unreadable contract address type ${type}`);
}

/** An `SCSymbol`, which is how a contract's function name travels. */
function readSymbol(r) {
  const length = r.u32();
  if (length > 32) throw new SuspiciousSetup('that is not a function name');
  return new TextDecoder().decode(r.padded(length));
}

/**
 * One argument of the invocation, in the three shapes a burn is made of.
 *
 * Everything else is refused rather than skipped. Skipping an argument type
 * means not knowing how many bytes it was, and a reader that has lost its
 * place will happily report an amount read out of the middle of something
 * else.
 */
function readScVal(r) {
  const type = r.u32();
  if (type === SCV_ADDRESS) return { kind: 'address', address: readScAddress(r) };
  if (type === SCV_BYTES) return { kind: 'bytes', bytes: r.padded(r.u32()) };
  if (type === SCV_I128) {
    // Int128Parts: a signed high half and an unsigned low one. Amounts here
    // are small and positive, so the high half being anything but zero is
    // already wrong, but it is read properly rather than assumed.
    const hi = BigInt.asIntN(64, r.u64());
    const lo = r.u64();
    return { kind: 'i128', value: (hi << 64n) | lo };
  }
  throw new SuspiciousSetup(`a burn does not carry an argument of type ${type}`);
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
  if (type === INVOKE_HOST_FUNCTION) {
    const kind = r.u32();
    if (kind !== HOST_FUNCTION_INVOKE_CONTRACT) {
      throw new SuspiciousSetup(
        'this transaction deploys or uploads a contract rather than calling one. Nothing has been signed.',
      );
    }
    const contract = readScAddress(r);
    const fn = readSymbol(r);
    const count = r.u32();
    if (count > 16) throw new SuspiciousSetup('too many arguments for a burn');
    const args = [];
    for (let i = 0; i < count; i += 1) args.push(readScVal(r));

    // The operation ends with its authorisation entries. A burn the user
    // signs for themselves needs none: their signature on the transaction is
    // the authorisation. Anything else is a tree of credentials and nested
    // invocations, and reading it properly is a parser of its own, so the
    // walk stops instead of guessing at lengths it does not know.
    const auth = r.u32();
    if (auth > 0) r.stopped = 'authorisation entries';
    return { type: 'invokeContract', source, contract, fn, args, auth };
  }
  throw new SuspiciousSetup(`a setup does not contain operation type ${type}`);
}

/**
 * Decodes a transaction envelope far enough to say who is being asked for
 * what. Not a general XDR reader and not trying to be, everything outside
 * the shapes a setup is made of is a refusal.
 */
export function parseEnvelope(base64) {
  const raw = atob(base64);
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const r = new Reader(bytes);

  const envelopeType = r.u32();
  if (envelopeType !== 2) throw new SuspiciousSetup('not a v1 transaction envelope');

  const source = readMuxed(r);
  // The fee is the ceiling on what this signature can cost. On a Soroban
  // transaction it also covers the resource fee, so reading it here is what
  // stops a tampered watcher from attaching an enormous footprint and
  // draining the XLM the user keeps for their own reserve.
  const fee = r.u32();
  r.skip64(); // sequence number
  readPreconditions(r);
  readMemo(r);

  const count = r.u32();
  if (count > 100) throw new SuspiciousSetup('too many operations');
  const operations = [];
  for (let i = 0; i < count; i += 1) operations.push(readOperation(r, source));

  // An operation may have read as far as it safely can. Everything the checks
  // below rely on is already out; what remains cannot move money that the fee
  // does not bound.
  if (r.stopped) return { source, fee, operations, unread: r.stopped };

  const ext = r.u32();
  if (ext === 1) {
    // A prepared Soroban transaction carries its resource footprint here, and
    // reading it means reading LedgerKeys, which is a great deal of parser for
    // no gain: nothing after this point can move money that the fee above does
    // not already bound, and the operation that can has already been read.
    //
    // So the walk stops, and says so rather than pretending otherwise. What is
    // still guaranteed: one operation, its contract, its function, its
    // arguments, and the fee. What is not: the footprint, the authorisation
    // entries and the signatures are unread.
    return { source, fee, operations, unread: 'the resource footprint' };
  }
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

  return { source, fee, operations, unread: null };
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A `G…` address as its raw 32 bytes. */
function accountBytes(address) {
  const decoded = base32Decode(address);
  if (!decoded || decoded.length !== 35) throw new SuspiciousSetup('unreadable address');
  return Uint8Array.from(decoded.slice(1, 33));
}

/** A `C…` contract id as its raw 32 bytes. */
function contractBytes(id) {
  const decoded = base32Decode(id);
  if (!decoded || decoded.length !== 35 || decoded[0] !== VERSION_CONTRACT) {
    throw new SuspiciousSetup('unreadable contract id');
  }
  return Uint8Array.from(decoded.slice(1, 33));
}

/// One XLM is ten million stroops. A burn's fee is a rounding error next to
/// the amount being moved, and this is only here to bound a tampered
/// footprint, so the ceiling is deliberately generous rather than tight.
const MAX_FEE_STROOPS = 20_000_000;

/**
 * Refuses to sign anything but the burn the user asked for.
 *
 * The inbound setup has {assertOnlyAskingForTrustline}; this is the same
 * defence pointed the other way, and it was missing. Going out, the page took
 * whatever XDR the API returned and handed it straight to Freighter. Freighter
 * shows a Soroban invocation as a contract id and a blob of arguments, so
 * "read it before you sign" was advice nobody could follow. A watcher that had
 * been tampered with could have returned a call moving the user's whole USDC
 * balance somewhere else and the page would have passed it on without
 * comment.
 *
 * So the page checks: one operation, our contract, the `bridge` function, the
 * user as the source of their own money, the amount they typed, the recipient
 * they typed. Anything else is refused before a wallet opens.
 *
 * @param amount stroops as a BigInt, in Stellar's seven decimals.
 * @throws {SuspiciousSetup} with something a person can act on.
 */
export function assertBurnsYourOwnUsdc(envelope, { user, contractId, amount, recipient }) {
  const userBytes = accountBytes(user);
  const expectedContract = contractBytes(contractId);

  if (!sameBytes(envelope.source, userBytes)) {
    throw new SuspiciousSetup(
      'this transaction is drawn on an account that is not yours. Nothing has been signed.',
    );
  }
  if (envelope.fee > MAX_FEE_STROOPS) {
    throw new SuspiciousSetup(
      `this transaction would charge ${(envelope.fee / 1e7).toFixed(2)} XLM in fees, ` +
        'far more than a burn costs. Nothing has been signed.',
    );
  }
  if (envelope.operations.length !== 1) {
    throw new SuspiciousSetup(
      `this transaction contains ${envelope.operations.length} operations. ` +
        'A burn is exactly one. Nothing has been signed.',
    );
  }

  const [op] = envelope.operations;
  if (op.type !== 'invokeContract') {
    throw new SuspiciousSetup(
      `this transaction asks your account to perform a ${op.type} rather than a burn. ` +
        'Nothing has been signed.',
    );
  }
  if (op.contract.kind !== 'contract' || !sameBytes(op.contract.bytes, expectedContract)) {
    throw new SuspiciousSetup(
      'this transaction calls a contract that is not the bridge. Nothing has been signed.',
    );
  }
  if (op.fn !== 'bridge') {
    throw new SuspiciousSetup(
      `this transaction calls ${op.fn} rather than bridge. Nothing has been signed.`,
    );
  }
  if (op.args.length !== 3) {
    throw new SuspiciousSetup(
      `this burn carries ${op.args.length} arguments rather than three. Nothing has been signed.`,
    );
  }

  const [from, value, destination] = op.args;
  if (
    from.kind !== 'address' ||
    from.address.kind !== 'account' ||
    !sameBytes(from.address.bytes, userBytes)
  ) {
    throw new SuspiciousSetup(
      'this burn takes the money from an account that is not yours, which means it is not the ' +
        'one you asked for. Nothing has been signed.',
    );
  }
  if (value.kind !== 'i128' || value.value !== amount) {
    const shown = value.kind === 'i128' ? (Number(value.value) / 1e7).toFixed(7) : 'something unreadable';
    throw new SuspiciousSetup(
      `this burn is for ${shown} USDC, not the amount you entered. Nothing has been signed.`,
    );
  }
  if (destination.kind !== 'bytes' || !sameBytes(destination.bytes, evmBytes(recipient))) {
    throw new SuspiciousSetup(
      'this burn would deliver to a different address than the one you entered. Nothing has been signed.',
    );
  }

  return envelope;
}

/** The twenty raw bytes of an EVM address, for comparing against the argument. */
function evmBytes(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new SuspiciousSetup('unreadable recipient');
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) out[i] = parseInt(address.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
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
