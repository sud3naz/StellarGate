/**
 * What this browser has sent, and how each one ended.
 *
 * Kept here rather than asked for. The watcher knows every transfer it has
 * ever handled, so a "list them" endpoint would be one request away from
 * showing everybody's to anybody, and a bridge's history is a list of who
 * paid whom. Recording locally means "my transfers" is exactly the set this
 * browser started, with no question of whose is whose.
 *
 * The cost is honest and worth stating: clear the browser and the list goes.
 * Nothing is lost by it. The money moved on two chains that remember perfectly
 * well, and every row here carries the hashes to prove it, this is a
 * convenience, not a ledger.
 */

const KEY = 'stellar-bridge:transfers';
const LIMIT = 50;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    // A corrupt entry should cost somebody their history and not their page.
    return [];
  }
}

function write(entries) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, LIMIT)));
  } catch {
    // Full or refused. Recording is a courtesy and never worth an exception
    // in the middle of a transfer.
  }
}

/** Records a burn the moment it lands, before anything downstream happens. */
export function remember(transfer) {
  const entries = read().filter((e) => e.txHash !== transfer.txHash);
  entries.unshift({ ...transfer, at: new Date().toISOString() });
  write(entries);
  return entries;
}

export function forget(txHash) {
  write(read().filter((e) => e.txHash !== txHash));
}

export function all() {
  return read();
}

/**
 * Marks one as finished, so a row stops asking after the answer arrives.
 *
 * Only ever called with what the watcher said, because "delivered" is a claim
 * about a chain and not something the page gets to decide.
 */
export function settle(txHash, delivery) {
  const entries = read();
  const found = entries.find((e) => e.txHash === txHash);
  if (!found) return entries;
  found.delivered = delivery ?? true;
  write(entries);
  return entries;
}
