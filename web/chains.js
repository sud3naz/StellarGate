/**
 * The ends this bridge can have, and the ones it cannot have yet.
 *
 * CCTP reaches a long way — every chain here is one Circle already carries
 * USDC between — and almost none of that reach is ours. What makes a route
 * work is a contract on the source side to take the fee and a watcher that
 * knows how to finish it, and today that is Base and Stellar.
 *
 * The rest are listed anyway, disabled. Leaving a chain out only prompts the
 * question again from somebody who knows CCTP supports it; saying "not yet"
 * answers it. The `domain` is Circle's, and it is filled in only where it has
 * been read off their own contract tables rather than remembered — a wrong
 * domain is a burn that mints somewhere nobody is looking.
 */

export const CHAINS = {
  base: {
    name: 'Base',
    domain: 6,
    family: 'evm',
    live: true,
    /// What "arriving able to spend it" means here. Nothing, yet: a user
    /// bridging to Base lands with USDC and no ETH to move it with.
    arrivesReady: false,
  },
  stellar: {
    name: 'Stellar',
    domain: 27,
    family: 'stellar',
    live: true,
    /// The whole point of the forward direction: an account, a trustline, and
    /// enough XLM to pay for its own next transaction.
    arrivesReady: true,
  },

  ethereum: { name: 'Ethereum', domain: 0, family: 'evm', live: false },
  avalanche: { name: 'Avalanche', domain: 1, family: 'evm', live: false },
  optimism: { name: 'OP Mainnet', domain: 2, family: 'evm', live: false },
  arbitrum: { name: 'Arbitrum', domain: 3, family: 'evm', live: false },
  polygon: { name: 'Polygon PoS', domain: 7, family: 'evm', live: false },
  // Domain left out where it has not been read off Circle's tables. A name is
  // enough to say "not yet", and a guessed number would be worse than none.
  solana: { name: 'Solana', family: 'other', live: false },
  sui: { name: 'Sui', family: 'other', live: false },
  aptos: { name: 'Aptos', family: 'other', live: false },
  unichain: { name: 'Unichain', family: 'evm', live: false },
  linea: { name: 'Linea', family: 'evm', live: false },
};

export const ROUTES = {
  'base>stellar': { live: true },
  'stellar>base': { live: true },
};

export const routeKey = (from, to) => `${from}>${to}`;

/**
 * Whether a pair is something this bridge can actually carry.
 *
 * Both ends live is necessary and not sufficient: a route is a contract and a
 * watcher, not a pair of chains, and saying otherwise would be the interface
 * implying something works.
 */
export function routeStatus(from, to) {
  if (from === to) return { ok: false, reason: 'Pick two different chains.' };

  const source = CHAINS[from];
  const destination = CHAINS[to];
  if (!source || !destination) return { ok: false, reason: 'Unknown chain.' };

  if (!source.live) return { ok: false, reason: `${source.name} is not connected yet.` };
  if (!destination.live) return { ok: false, reason: `${destination.name} is not connected yet.` };

  const route = ROUTES[routeKey(from, to)];
  if (!route?.live) {
    return { ok: false, reason: `${source.name} to ${destination.name} is not built yet.` };
  }
  return { ok: true };
}

/** Fills a `<select>`, with what we cannot carry disabled rather than absent. */
export function fillChainPicker(select, selected) {
  select.innerHTML = '';
  for (const [id, chain] of Object.entries(CHAINS)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = chain.live ? chain.name : `${chain.name} — coming soon`;
    option.disabled = !chain.live;
    option.selected = id === selected;
    select.append(option);
  }
}
