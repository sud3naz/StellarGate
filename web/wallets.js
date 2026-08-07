/**
 * Finding the wallets somebody actually has, rather than guessing at one.
 *
 * `window.ethereum` is whichever extension won a race to write to it. Reaching
 * for it means a user with three wallets is connected to whichever one shoved
 * hardest, with no say and often no idea which. EIP-6963 exists for exactly
 * this: the page asks, every wallet answers with its own name, icon and
 * provider, and the choice belongs to the person making it.
 *
 * The Stellar side has no such standard, so it is done the honest way round —
 * a short list of the globals known wallets inject, checked for. A wallet not
 * on that list is missed, which is a reason to keep the list current and not a
 * reason to pretend `window.freighterApi` is the only way to hold XLM.
 */

/**
 * Asks the browser's wallets to announce themselves.
 *
 * @param settle How long to wait. Extensions answer synchronously, so this is
 *        insurance against a slow one rather than a real delay.
 */
export function discoverEvmWallets({ settle = 120 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();

    const onAnnounce = (event) => {
      const { info, provider } = event.detail ?? {};
      if (info?.uuid && provider) found.set(info.uuid, { info, provider });
    };

    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));

    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      const wallets = [...found.values()].map(({ info, provider }) => ({
        id: info.uuid,
        name: info.name,
        icon: info.icon,
        provider,
      }));

      // Older wallets do not announce. One that is present and silent is
      // better offered under a vague name than not offered at all.
      if (wallets.length === 0 && window.ethereum) {
        wallets.push({ id: 'injected', name: 'Browser wallet', icon: null, provider: window.ethereum });
      }
      resolve(wallets);
    }, settle);
  });
}

/**
 * The Stellar wallets that announce themselves by writing to `window`.
 *
 * Kept as data rather than as a chain of ifs, because the list is the part
 * that goes out of date.
 */
/**
 * The Stellar wallets this page can honestly ask.
 *
 * One, for now, and that is the point rather than an embarrassment. An earlier
 * version of this file listed four, written from memory: xBull as
 * `window.xBullSDK`, LOBSTR as `window.lobstrApi`, Freighter as
 * `window.freighterApi`. Checked against Stellar Wallets Kit — the maintained
 * multi-wallet connector, which is where the real answers are — three of the
 * four were wrong. xBull is an iframe bridge from
 * `@creit.tech/xbull-wallet-connect`, LOBSTR is
 * `@lobstrco/signer-extension-api`, and Freighter puts nothing on the page at
 * all. Only Rabet's global was right, and even that needs waiting for: the
 * extension injects late enough that a synchronous check misses it.
 *
 * A wallet listed and wrong is worse than one not listed. It offers itself,
 * takes the click, and fails somewhere the user cannot read — which is exactly
 * what "no Stellar wallet found" meant to somebody who had Freighter
 * installed. So the guesses are gone.
 *
 * Adding the rest properly means adopting the Kit, which pulls in Preact,
 * Ledger, Trezor and WalletConnect and needs a bundler this page does not
 * have. That is the work, and it is not the same as three lines of `window.x`.
 */
const STELLAR_WALLETS = [
  {
    id: 'freighter',
    name: 'Freighter',
    // Its own library, vendored. `window.freighter` is the extension saying
    // it is there; `window.freighterApi` is the library saying it has loaded.
    detect: () => window.freighter === true && Boolean(window.freighterApi),
    api: () => window.freighterApi,
  },
];

export function discoverStellarWallets() {
  return STELLAR_WALLETS.filter((wallet) => {
    try {
      return wallet.detect();
    } catch {
      return false;
    }
  }).map((wallet) => ({ id: wallet.id, name: wallet.name, api: wallet.api() }));
}

/**
 * Signs an XDR with whichever Stellar wallet was picked.
 *
 * The same spread of interfaces as reading an address, for the same reason:
 * these were built before there was a common one. What matters here is that a
 * wallet this page cannot ask properly is refused loudly rather than handed a
 * transaction it will interpret its own way.
 */
export async function signWithStellar(wallet, xdr, { networkPassphrase, address }) {
  const api = wallet.api;

  if (wallet.id === 'freighter') {
    const signed = await api.signTransaction(xdr, { networkPassphrase, address });
    if (signed?.error) throw new Error(signed.error.message ?? String(signed.error));
    return typeof signed === 'string' ? signed : signed.signedTxXdr;
  }
  throw new Error(`${wallet.name} is not one this page knows how to ask for a signature`);
}
