/**
 * Channel accounts, and who is holding which one.
 *
 * A setup is signed by the user before the burn and submitted after it, and
 * in between it carries a sequence number that nothing else may use. One
 * channel means one sequence number, so two users who both asked for a setup
 * in the same window were handed the same one, and whichever burned second
 * found their transaction refused with `tx_bad_seq`, having already paid.
 *
 * So there is a pool, and a channel is *reserved* for a recipient from the
 * moment its setup is built until that setup is submitted or the hold
 * expires. The hold is as long as the transaction's own time bound: past it
 * the held setup is unsubmittable anyway, so the channel can be lent again.
 *
 * Asking twice for the same recipient returns the same channel. A page that
 * retries `/setup` is not two users, and treating it as two would burn
 * through the pool on one person's reloads.
 *
 * What this does not solve: a pool of N channels is exhausted by N distinct
 * recipients who ask and walk away, for as long as the hold lasts. That is a
 * rate-limiting problem and it belongs in front of the endpoint, not here.
 */

export class NoFreeChannel extends Error {}

export class ChannelPool {
  /**
   * @param signers     Keypairs, one per channel account. All must be funded
   *                    with enough XLM to pay setup fees.
   * @param holdSeconds How long a reservation lasts. Match it to the
   *                    setup's time bound: a reservation that outlives the
   *                    transaction it protects is a channel idling for
   *                    nothing, and one that ends earlier is the collision
   *                    this exists to prevent.
   */
  constructor(signers, { holdSeconds = 45 * 60, now = () => Date.now() } = {}) {
    if (!signers?.length) throw new Error('a channel pool needs at least one channel');
    this.signers = [...signers];
    this.holdMs = holdSeconds * 1000;
    this.now = now;
    /// account -> { recipient, until }
    this.holds = new Map();
  }

  get size() {
    return this.signers.length;
  }

  #live(hold) {
    return hold && hold.until > this.now();
  }

  /** How many channels are held right now. */
  busy() {
    let count = 0;
    for (const hold of this.holds.values()) if (this.#live(hold)) count += 1;
    return count;
  }

  /**
   * A channel for this recipient, held until released or expired.
   * @throws {NoFreeChannel} when every channel is held by somebody else.
   */
  reserve(recipient) {
    if (!recipient) throw new Error('a channel is reserved for somebody');
    const until = this.now() + this.holdMs;

    // The same recipient asking again keeps what they had, and the hold is
    // refreshed: the setup they are about to be handed is a new transaction.
    for (const signer of this.signers) {
      const hold = this.holds.get(signer.publicKey());
      if (this.#live(hold) && hold.recipient === recipient) {
        hold.until = until;
        return signer;
      }
    }

    for (const signer of this.signers) {
      if (!this.#live(this.holds.get(signer.publicKey()))) {
        this.holds.set(signer.publicKey(), { recipient, until });
        return signer;
      }
    }

    throw new NoFreeChannel(
      `all ${this.signers.length} channel accounts are busy; try again in a moment`,
    );
  }

  /** Lets go of whatever this recipient was holding. Harmless if nothing. */
  release(recipient) {
    for (const [account, hold] of this.holds) {
      if (hold.recipient === recipient) this.holds.delete(account);
    }
  }

  /**
   * Lets go of a channel by its account, which is what a submitted setup
   * names as its source. Harmless if it was not held.
   */
  releaseAccount(account) {
    this.holds.delete(account);
  }

  /** Who holds a channel, for the health line. */
  holder(account) {
    const hold = this.holds.get(account);
    return this.#live(hold) ? hold.recipient : null;
  }
}
