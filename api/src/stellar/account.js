/**
 * What a destination address needs before USDC can land on it.
 *
 * The forwarder finishes a delivery with an ordinary SAC transfer, so an
 * account that does not exist, or exists without a USDC trustline, will make
 * that transfer fail. It fails cleanly, the CCTP message is not consumed and
 * the delivery can be retried, but the user is left waiting, so the point is
 * to know what is missing before they ever burn anything.
 */

const STROOPS = 10_000_000n;

/**
 * Reserves are a network parameter, not a constant. They have been 0.5 XLM for
 * years and could stop being that by validator vote, so they are read.
 */
export async function baseReserve(horizon, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${horizon}/ledgers?order=desc&limit=1`);
  if (!response.ok) throw new Error(`horizon ledgers: ${response.status}`);
  const body = await response.json();
  const stroops = body?._embedded?.records?.[0]?.base_reserve_in_stroops;
  if (typeof stroops !== 'number') throw new Error('horizon returned no base reserve');
  return BigInt(stroops);
}

/**
 * @param horizon  Horizon base URL.
 * @param address  The user's `G…` address. A muxed `M…` address shares the
 *                 underlying account, so callers pass the account itself.
 * @param asset    The USDC asset for this network.
 * @param amount   Optional, as a decimal string in USDC units. Used only to
 *                 check the transfer would actually fit; Stellar carries seven
 *                 decimals where the EVM side carries six, so amounts cross
 *                 this boundary as decimal text rather than as integers.
 */
export async function inspect(horizon, address, asset, { amount = null, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${horizon}/accounts/${address}`);

  if (response.status === 404) {
    const reserve = await baseReserve(horizon, { fetchImpl });
    return {
      address,
      exists: false,
      hasTrustline: false,
      needs: 'account+trustline',
      // Two base reserves for the account, one more for the trustline.
      reserveStroops: reserve * 3n,
      reserveXlm: formatStroops(reserve * 3n),
      headroom: null,
      deliverable: true,
    };
  }
  if (!response.ok) throw new Error(`horizon accounts: ${response.status}`);

  const account = await response.json();
  const line = (account.balances || []).find(
    (b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );

  if (!line) {
    const reserve = await baseReserve(horizon, { fetchImpl });
    const spendable = spendableStroops(account, reserve);
    return {
      address,
      exists: true,
      hasTrustline: false,
      needs: 'trustline',
      reserveStroops: reserve,
      reserveXlm: formatStroops(reserve),
      // An existing account pays its own trustline reserve out of the XLM it
      // already holds, but only if it holds enough. Whether it does decides
      // between "sign this" and "you are half an XLM short".
      spendableStroops: spendable,
      spendableXlm: formatStroops(spendable),
      canAffordTrustline: spendable >= reserve,
      headroom: null,
      deliverable: true,
    };
  }

  // A trustline has a ceiling, and a transfer that would breach it fails the
  // same way a missing trustline does. Worth catching before the burn rather
  // than after.
  const headroom = toStroops(line.limit) - toStroops(line.balance);
  const deliverable = amount === null || headroom >= toStroops(amount);

  return {
    address,
    exists: true,
    hasTrustline: true,
    needs: 'nothing',
    reserveStroops: 0n,
    reserveXlm: '0',
    headroom: formatStroops(headroom),
    deliverable,
    // An unauthorised trustline cannot receive. Circle's issuers do not set
    // auth_required, but a future issuer might, and silently delivering into a
    // frozen line is not a failure worth discovering later.
    authorized: line.is_authorized !== false,
  };
}

/**
 * XLM the account may actually spend.
 *
 * Not the native balance: an account must keep two base reserves for itself
 * and one for every subentry it holds, plus whatever it has committed to sell.
 * Sponsorship shifts the burden, reserves an account sponsors for others
 * count against it, and reserves sponsored on its behalf do not.
 */
export function spendableStroops(account, reserve) {
  const native = (account.balances || []).find((b) => b.asset_type === 'native');
  if (!native) return 0n;

  const subentries = BigInt(account.subentry_count ?? 0);
  const sponsoring = BigInt(account.num_sponsoring ?? 0);
  const sponsored = BigInt(account.num_sponsored ?? 0);

  const minimum = (2n + subentries + sponsoring - sponsored) * reserve;
  const liabilities = toStroops(native.selling_liabilities ?? '0');
  const spendable = toStroops(native.balance) - minimum - liabilities;

  return spendable > 0n ? spendable : 0n;
}

export function toStroops(decimal) {
  const [whole, fraction = ''] = String(decimal).split('.');
  const padded = (fraction + '0000000').slice(0, 7);
  return BigInt(whole) * STROOPS + BigInt(padded);
}

export function formatStroops(stroops) {
  const negative = stroops < 0n;
  const value = negative ? -stroops : stroops;
  const whole = value / STROOPS;
  const fraction = (value % STROOPS).toString().padStart(7, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
