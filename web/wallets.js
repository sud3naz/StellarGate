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
const STELLAR_WALLETS = [
  { id: 'freighter', name: 'Freighter', global: 'freighterApi' },
  { id: 'xbull', name: 'xBull', global: 'xBullSDK' },
  { id: 'rabet', name: 'Rabet', global: 'rabet' },
  { id: 'lobstr', name: 'LOBSTR', global: 'lobstrApi' },
];

export function discoverStellarWallets() {
  return STELLAR_WALLETS.filter((wallet) => window[wallet.global]).map((wallet) => ({
    ...wallet,
    api: window[wallet.global],
  }));
}

/**
 * Reads an address out of whichever Stellar wallet was picked.
 *
 * Each of these grew its own interface before there was a common one, so the
 * shapes differ and none of them is wrong. Guessing at a wallet that answers
 * to none of them would be.
 */
export async function stellarAddress(wallet) {
  const api = wallet.api;

  if (wallet.id === 'freighter') {
    if (api.setAllowed) await api.setAllowed();
    const result = await (api.getAddress ? api.getAddress() : api.getPublicKey());
    return typeof result === 'string' ? result : result.address;
  }
  if (wallet.id === 'xbull') {
    await api.connect?.({ canRequestPublicKey: true, canRequestSign: true });
    return api.getPublicKey();
  }
  if (wallet.id === 'rabet') {
    const result = await api.connect();
    return result.publicKey;
  }
  if (wallet.id === 'lobstr') {
    return api.getPublicKey();
  }
  throw new Error(`${wallet.name} is not one this page knows how to ask`);
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
    return typeof signed === 'string' ? signed : signed.signedTxXdr;
  }
  if (wallet.id === 'xbull') {
    return api.signXDR(xdr, { publicKey: address, network: networkPassphrase });
  }
  if (wallet.id === 'rabet') {
    const signed = await api.sign(xdr, networkPassphrase.includes('Test') ? 'testnet' : 'mainnet');
    return signed.xdr;
  }
  if (wallet.id === 'lobstr') {
    return api.signTransaction(xdr);
  }
  throw new Error(`${wallet.name} is not one this page knows how to ask for a signature`);
}
