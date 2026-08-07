/**
 * What the watcher remembers, and the one thing it must never forget.
 *
 * A burn pays for one activation. If the same burn can be presented twice —
 * because a retry looked like a new transfer, or because the process restarted
 * and forgot — then three XLM go out again for money that was only paid once,
 * and the endpoint that funds Stellar accounts is free to whoever loops it.
 * That is the same attack `flow.js` describes, arriving through the back door.
 *
 * So the claim is a **claim**, not a question. `claimActivation` returns true
 * exactly once for a given burn and false forever after, and there is no
 * moment between asking and taking where a second caller can slip in. Code
 * that asks `hasSpent` and then spends has a window; this has none.
 *
 * Restarting is the other half. An in-memory claim that vanishes on restart is
 * not a claim, so the state is written out on every change. The file is the
 * record; the Map is a cache of it.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

export class DoublePayment extends Error {}

export class Store {
  /**
   * @param path Where to persist. Omit for a store that lives and dies with
   *        the process — fine for tests, not for anything that sends XLM.
   */
  constructor({ path = null } = {}) {
    this.path = path;
    this.transfers = new Map();
    if (path && existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      for (const [key, value] of Object.entries(raw)) this.transfers.set(key, value);
    }
  }

  /**
   * @dev Written to a neighbouring file and renamed, because a process killed
   * mid-write would otherwise leave a truncated record of what has been paid
   * for — and a store that cannot be read is a store that funds everything
   * twice.
   */
  #persist() {
    if (!this.path) return;
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(Object.fromEntries(this.transfers), null, 2));
    renameSync(temp, this.path);
  }

  /**
   * Records a transfer the first time it is seen. Seeing it again is normal —
   * logs get re-read after a restart — and must not disturb what is already
   * known about it.
   */
  remember({ txHash, recipient, setupXdr = null }) {
    if (!txHash || !recipient) throw new Error('a transfer needs a burn and a recipient');

    const existing = this.transfers.get(txHash);
    if (existing) {
      if (existing.recipient !== recipient) {
        // The same burn cannot have paid for two addresses. Either the log was
        // misread or something is being replayed at us.
        throw new DoublePayment(
          `burn ${txHash} is already recorded for ${existing.recipient}, not ${recipient}`,
        );
      }
      if (setupXdr && !existing.setupXdr) {
        existing.setupXdr = setupXdr;
        this.#persist();
      }
      return existing;
    }

    const transfer = {
      txHash,
      recipient,
      setupXdr,
      activationClaimed: false,
      provisioned: false,
      deliveredAt: null,
    };
    this.transfers.set(txHash, transfer);
    this.#persist();
    return transfer;
  }

  get(txHash) {
    return this.transfers.get(txHash) ?? null;
  }

  /**
   * Takes the right to spend XLM against this burn, once.
   *
   * @returns true if the caller now holds that right, false if somebody
   *          already did. A false is not an error — a retry landing on an
   *          activation that already happened is the ordinary case.
   */
  claimActivation(txHash) {
    const transfer = this.transfers.get(txHash);
    if (!transfer) throw new DoublePayment(`no record of burn ${txHash}`);
    if (transfer.activationClaimed) return false;

    transfer.activationClaimed = true;
    this.#persist();
    return true;
  }

  markProvisioned(txHash) {
    const transfer = this.transfers.get(txHash);
    if (!transfer) throw new DoublePayment(`no record of burn ${txHash}`);
    transfer.provisioned = true;
    this.#persist();
    return transfer;
  }

  markDelivered(txHash, stellarTxHash) {
    const transfer = this.transfers.get(txHash);
    if (!transfer) throw new DoublePayment(`no record of burn ${txHash}`);
    transfer.deliveredAt = { stellarTxHash, at: new Date().toISOString() };
    this.#persist();
    return transfer;
  }

  /// Everything still owed a delivery, which is the watcher's work queue.
  pending() {
    return [...this.transfers.values()].filter((t) => !t.deliveredAt);
  }
}
