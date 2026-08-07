/**
 * The bridge, from the browser's side.
 *
 * Two things here are real today and worth knowing are real: the destination
 * inspection talks to Horizon, and the address check is the same base32 and
 * CRC16 the contract runs. Everything that needs a deployed contract is behind
 * `CONFIG.bridge`, and while that is empty the page says so rather than
 * pretending.
 */

import { strkeyKind, underlyingAccount } from './strkey.js';
import { encodeApprove, encodeBridge } from './abi.js';
import { parseEnvelope, assertOnlyAskingForTrustline } from './envelope.js';
import { CHAINS, routeStatus, fillChainPicker } from './chains.js';
import {
  discoverEvmWallets,
  discoverStellarWallets,
  stellarAddress,
  signWithStellar,
} from './wallets.js';

const CONFIG = {
  network: 'testnet',

  // Filled in after deployment. Empty on purpose until then.
  bridge: '0x69752D7C3d1c7C919bc24e34cD440762F642FF00',

  // Where the watcher listens. It builds the setup — the channel's sequence
  // number and the funder's address are not the browser's business — and it
  // takes the signed one back afterwards.
  //
  // Fixed here on purpose, and deliberately not read from the URL. This page
  // signs whatever transaction that origin hands it, so a `?api=` override
  // would be an invitation: point somebody at the real page with a hostile
  // watcher behind it and Freighter is asked to sign whatever it likes. The
  // origin has to be as fixed as the contract address, and it is listed in
  // the CSP for the same reason.
  //
  // There is no hosted watcher yet, so this is a local one. A deployment that
  // means to complete transfers has to change both this and `connect-src` in
  // vercel.json.
  api: 'http://localhost:8787',

  base: {
    chainIdHex: '0x14a34', // Base Sepolia
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    explorer: 'https://sepolia.basescan.org',
  },
  stellar: {
    horizon: 'https://horizon-testnet.stellar.org',
    soroban: 'https://soroban-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
    usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    explorer: 'https://stellar.expert/explorer/testnet',
  },

  // Mirrors of the contract's constants. If these drift the quote lies, so
  // they are read back from the contract once one is deployed.
  feeBps: 50n,
  bpsDenom: 10_000n,
  activationFee: 3_000_000n, // 3 USDC, six decimals
  minAmount: 1_000_000n,
};

const $ = (id) => document.getElementById(id);
const el = {
  net: $('net'),
  fromChain: $('fromChain'),
  toChain: $('toChain'),
  swap: $('swap'),
  sheet: $('sheet'),
  sheetTitle: $('sheetTitle'),
  sheetList: $('sheetList'),
  sheetCancel: $('sheetCancel'),
  fromWho: $('fromWho'),
  toWho: $('toWho'),
  connectEvm: $('connectEvm'),
  connectStellar: $('connectStellar'),
  amount: $('amount'),
  max: $('max'),
  balance: $('balance'),
  dest: $('dest'),
  status: $('status'),
  qSend: $('qSend'),
  qFee: $('qFee'),
  qAct: $('qAct'),
  qActRow: $('qActRow'),
  qGet: $('qGet'),
  go: $('go'),
  steps: [$('s1'), $('s2'), $('s3'), $('s4')],
};

const state = {
  from: 'base',
  to: 'stellar',
  stellarWallet: null,
  /// The provider the user picked, not whichever one wrote to window first.
  evmProvider: null,
  evm: null,
  stellar: null,
  balance: null, // BigInt, six decimals
  inspection: null, // from Horizon
  checking: false,
};

// --------------------------------------------------------------------------
// Amounts
// --------------------------------------------------------------------------

function parseUsdc(text) {
  const cleaned = String(text ?? '').trim().replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '' || cleaned === '.') return null;
  const [whole, fraction = ''] = cleaned.split('.');
  return BigInt(whole || '0') * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
}

function formatUsdc(value) {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const whole = (v / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (v % 1_000_000n).toString().padStart(6, '0').slice(0, 2);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** The same arithmetic the contract does, so the quote cannot flatter us. */
function quote(amount, activate) {
  let fee = (amount * CONFIG.feeBps) / CONFIG.bpsDenom;
  const activation = activate ? CONFIG.activationFee : 0n;
  fee += activation;
  return { fee, activation, net: amount - fee };
}

// --------------------------------------------------------------------------
// Horizon: what does this address need
// --------------------------------------------------------------------------

async function inspect(address) {
  const account = underlyingAccount(address);
  const response = await fetch(`${CONFIG.stellar.horizon}/accounts/${account}`);

  if (response.status === 404) return { needs: 'account+trustline', fundsUser: true };
  if (!response.ok) throw new Error(`Horizon returned ${response.status}`);

  const body = await response.json();
  const line = (body.balances || []).find(
    (b) => b.asset_code === 'USDC' && b.asset_issuer === CONFIG.stellar.usdcIssuer,
  );
  if (line) return { needs: 'nothing', fundsUser: false, limit: line.limit, balance: line.balance };

  // An existing account pays its own trustline reserve, if it can afford one.
  const native = (body.balances || []).find((b) => b.asset_type === 'native');
  const reserve = 5_000_000n; // 0.5 XLM in stroops
  const subentries = BigInt(body.subentry_count ?? 0);
  const sponsoring = BigInt(body.num_sponsoring ?? 0);
  const sponsored = BigInt(body.num_sponsored ?? 0);
  const minimum = (2n + subentries + sponsoring - sponsored) * reserve;
  const balance = native ? BigInt(Math.round(parseFloat(native.balance) * 1e7)) : 0n;
  const spendable = balance - minimum;

  return spendable >= reserve
    ? { needs: 'trustline', fundsUser: false }
    : { needs: 'trustline', fundsUser: true, short: true };
}

const STATUS = {
  idle: ['is-idle', '?', 'Enter an address and we will check what it needs.'],
  checking: ['is-idle', '·', 'Checking this address on Stellar…'],
  invalid: ['is-bad', '!', '<b>That is not a valid Stellar address.</b><span class="sub">The checksum does not match, so a character is wrong somewhere. We check this before anything moves, because a wrong address cannot be undone.</span>'],
  nothing: ['is-ok', '✓', '<b>Ready to receive.</b><span class="sub">This account already holds USDC. Nothing to set up and nothing extra to pay.</span>'],
  trustline: ['is-ok', '✓', '<b>We will add the USDC trustline.</b><span class="sub">Your account covers its own half XLM reserve, so this costs you nothing beyond the bridge fee.</span>'],
  fund: ['is-warn', '+', '<b>This address cannot hold USDC yet.</b><span class="sub">We will send it 3 XLM so it can, and add the trustline. Charged once, and only to addresses that need it.</span>'],
  error: ['is-bad', '!', '<b>Could not reach Horizon.</b><span class="sub">The address may still be fine; we simply could not check it just now.</span>'],
};

/**
 * The kinds a status can be, for the ones that carry their own sentence.
 *
 * {STATUS} above is the presets — a fixed situation with fixed wording. These
 * are for the running commentary, where the wording is the point and only the
 * colour is reusable.
 */
const KINDS = {
  idle: ['is-idle', '?'],
  working: ['is-idle', '·'],
  done: ['is-ok', '✓'],
  warn: ['is-warn', '+'],
  bad: ['is-bad', '!'],
};

/**
 * @param key  A preset from {STATUS}, or a kind from {KINDS}.
 * @param html What to say, when the kind does not say it already.
 *
 * Both shapes are here because both were being called. The second one was
 * invented and never written: fifteen call sites passed a sentence to a
 * function that took one argument and read a table, so every one of them
 * destructured `undefined` and threw. That is what "the button does nothing"
 * was — the click worked, the first line of work threw, and the error went
 * somewhere nobody could see it.
 */
function setStatus(key, html) {
  const preset = STATUS[key];
  const [cls, icon] = preset ? preset : (KINDS[key] ?? KINDS.bad);
  const text = html ?? preset?.[2] ?? '';
  el.status.className = `status ${cls}`;
  el.status.innerHTML = `<span class="ic">${icon}</span><span>${text}</span>`;
}

/**
 * Says something went wrong, where it can be read.
 *
 * Not `el.statusText`: `setStatus` replaces the contents of the status box, so
 * the span that was captured at startup is detached the first time anything
 * happens. Writing an error to it succeeds and shows nobody anything, which is
 * a worse failure than the one being reported.
 */
function setError(error) {
  setStatus('bad', escapeHtml(String(error?.message ?? error)));
}

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// --------------------------------------------------------------------------
// Wallets
// --------------------------------------------------------------------------

/**
 * Asks which wallet, and waits for an answer.
 *
 * @returns the chosen entry, or `null` if the user closed it. A cancel is an
 *          answer and not an error.
 */
function chooseWallet(title, wallets, empty) {
  return new Promise((resolve) => {
    el.sheetTitle.textContent = title;
    el.sheetList.innerHTML = '';

    if (wallets.length === 0) {
      const note = document.createElement('div');
      note.className = 'none';
      note.textContent = empty;
      el.sheetList.append(note);
    }

    for (const wallet of wallets) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wallet';
      if (wallet.icon) {
        const icon = document.createElement('img');
        icon.src = wallet.icon;
        icon.alt = '';
        button.append(icon);
      }
      button.append(document.createTextNode(wallet.name));
      button.addEventListener('click', () => finish(wallet));
      el.sheetList.append(button);
    }

    function finish(picked) {
      el.sheet.hidden = true;
      el.sheetCancel.removeEventListener('click', onCancel);
      el.sheet.removeEventListener('click', onBackdrop);
      resolve(picked);
    }
    const onCancel = () => finish(null);
    const onBackdrop = (event) => {
      if (event.target === el.sheet) finish(null);
    };

    el.sheetCancel.addEventListener('click', onCancel);
    el.sheet.addEventListener('click', onBackdrop);
    el.sheet.hidden = false;
  });
}

async function connectEvm() {
  const wallets = await discoverEvmWallets();
  const picked = await chooseWallet(
    'Choose a wallet',
    wallets,
    'No wallet announced itself. Install one — Rabby and MetaMask both work — then reload.',
  );
  if (!picked) return;

  const provider = picked.provider;
  const [account] = await provider.request({ method: 'eth_requestAccounts' });
  state.evmProvider = provider;
  state.evm = account;

  // A wallet connected to some other chain answers `eth_call` from that chain,
  // which is how "could not read your balance" happens to somebody whose
  // balance is fine. Ask, and offer to move.
  try {
    await ensureChain(provider);
  } catch (error) {
    el.balance.textContent = String(error?.message ?? error);
  }
  // Enough of the address to tell two accounts in the same wallet apart, and
  // a link so it can be checked rather than trusted. Four characters at each
  // end is not enough for that and reads as reassurance.
  el.fromWho.innerHTML = '';
  const link = document.createElement('a');
  link.href = `${CONFIG.base.explorer}/address/${account}`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = `${account.slice(0, 10)}…${account.slice(-8)}`;
  el.fromWho.append(link);
  el.fromWho.classList.remove('empty');
  el.connectEvm.textContent = `${picked.name} connected`;
  el.connectEvm.disabled = true;

  await readBalance();
  render();
}

/**
 * Puts the wallet on the chain this page is talking about.
 *
 * `wallet_addEthereumChain` is the fallback rather than the opening move: a
 * wallet that already knows Base Sepolia should not be asked to add it again,
 * and a wallet that does not will refuse the switch with a code that says so.
 */
async function ensureChain(provider) {
  const wanted = CONFIG.base.chainIdHex;
  const current = await provider.request({ method: 'eth_chainId' });
  if (current === wanted) return;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: wanted }],
    });
  } catch (error) {
    // 4902: the wallet has never heard of it.
    if (error?.code !== 4902) throw new Error('Switch your wallet to Base Sepolia to continue.');

    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: wanted,
          chainName: 'Base Sepolia',
          nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://sepolia.base.org'],
          blockExplorerUrls: [CONFIG.base.explorer],
        },
      ],
    });
  }
}

async function readBalance() {
  if (!state.evm) return;
  try {
    const data = `0x70a08231000000000000000000000000${state.evm.slice(2)}`;
    const result = await state.evmProvider.request({
      method: 'eth_call',
      params: [{ to: CONFIG.base.usdc, data }, 'latest'],
    });
    state.balance = BigInt(result);
    const network = CONFIG.network === 'testnet' ? 'Base Sepolia' : 'Base';
    el.balance.textContent =
      state.balance === 0n
        ? `No USDC on ${network} in this account. That is the balance, not a failure to read it — testnet USDC comes from Circle's faucet.`
        : `${formatUsdc(state.balance)} USDC on ${network}.`;
  } catch (error) {
    // Saying only "could not" sends people looking at their balance, which is
    // the one thing that is fine.
    el.balance.textContent = `Could not read your USDC balance on Base Sepolia: ${
      error?.message ?? error
    }`;
  }
}

async function connectStellar() {
  const wallets = await discoverStellarWallets();
  const picked = await chooseWallet(
    'Choose a Stellar wallet',
    wallets,
    'Freighter is the only Stellar wallet this page can ask so far, and it is ' +
      'not answering. Install it, or unlock it, then reload.',
  );
  if (!picked) return;

  try {
    const address = await stellarAddress(picked);

    state.stellarWallet = picked;
    state.stellar = address;
    el.toWho.innerHTML = '';
    const seen = document.createElement('a');
    seen.href = `${CONFIG.stellar.explorer}/account/${address}`;
    seen.target = '_blank';
    seen.rel = 'noopener';
    seen.textContent = `${address.slice(0, 10)}…${address.slice(-8)}`;
    el.toWho.append(seen);
    el.toWho.classList.remove('empty');
    el.connectStellar.textContent = `${picked.name} connected`;
    el.connectStellar.disabled = true;

    // Prefill, but leave it editable: an exchange deposit needs a different
    // address than the one in the wallet.
    if (!el.dest.value) {
      el.dest.value = address;
      checkDestination();
    }
  } catch (error) {
    setStatus('idle');
    setError(error);
  }
  render();
}

// --------------------------------------------------------------------------
// Wiring
// --------------------------------------------------------------------------

let checkToken = 0;

async function checkDestination() {
  el.dest.classList.remove('bad');
  state.inspection = null;

  // An EVM destination has nothing to inspect. There is no account to create,
  // no trustline to add, and no checksum worth trusting — EIP-55 is about
  // capitalisation and says nothing once an address has been lowercased. So
  // the check is a shape and the honesty is in saying what does not happen.
  if (CHAINS[state.to].family === 'evm') {
    const raw = el.dest.value.trim();
    if (!raw) {
      setStatus('idle');
      render();
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      el.dest.classList.add('bad');
      setStatus('bad', 'That is not an address on ' + CHAINS[state.to].name + '.');
      render();
      return;
    }
    if (/^0x0{40}$/.test(raw)) {
      el.dest.classList.add('bad');
      setStatus('bad', 'That address is a hole. Nothing comes back out of it.');
      render();
      return;
    }
    state.inspection = { needs: 'nothing', evm: raw };
    setStatus(
      'warn',
      '<b>The USDC will arrive; the gas will not.</b>' +
        '<span class="sub">Nothing is set up for you on ' +
        CHAINS[state.to].name +
        ' — you will need its own currency before you can move what lands there.</span>',
    );
    render();
    return;
  }

  const address = el.dest.value.trim().toUpperCase();

  if (!address) {
    setStatus('idle');
    render();
    return;
  }
  if (!strkeyKind(address)) {
    el.dest.classList.add('bad');
    setStatus('invalid');
    render();
    return;
  }

  const token = ++checkToken;
  setStatus('checking');
  render();

  try {
    const result = await inspect(address);
    if (token !== checkToken) return; // a newer check overtook this one
    state.inspection = result;
    setStatus(result.needs === 'nothing' ? 'nothing' : result.fundsUser ? 'fund' : 'trustline');
  } catch {
    if (token !== checkToken) return;
    setStatus('error');
  }
  render();
}

function render() {
  const amount = parseUsdc(el.amount.value);
  const activate = state.inspection?.fundsUser === true;
  const floor = CONFIG.minAmount + (activate ? CONFIG.activationFee : 0n);

  if (amount === null || amount === 0n) {
    el.qSend.textContent = '—';
    el.qFee.textContent = '—';
    el.qGet.textContent = '—';
    el.qActRow.hidden = true;
  } else {
    const { fee, activation, net } = quote(amount, activate);
    el.qSend.textContent = `${formatUsdc(amount)} USDC`;
    el.qFee.textContent = `${formatUsdc(fee - activation)} USDC`;
    el.qActRow.hidden = !activate;
    el.qAct.textContent = `${formatUsdc(activation)} USDC`;
    el.qGet.textContent = net > 0n ? `${formatUsdc(net)} USDC` : '—';
  }

  const route = pickedRoute();
  const outbound = CHAINS[state.from].family === 'stellar';
  const ready =
    route.status.ok &&
    state.evm &&
    state.stellar &&
    state.inspection &&
    amount !== null &&
    amount >= floor;

  el.go.disabled = !ready || !CONFIG.bridge;
  el.go.textContent = !route.status.ok
    ? route.status.reason
    : !state.evm || !state.stellar
      ? 'Connect both wallets to begin'
      : !state.inspection
        ? `Enter a ${CHAINS[state.to].name} address`
        : amount === null || amount === 0n
          ? 'Enter an amount'
          : amount < floor
            ? `Minimum ${formatUsdc(floor)} USDC${activate ? ' with activation' : ''}`
            : !CONFIG.bridge
              ? 'Not deployed yet'
              : outbound
                ? `Bridge to ${CHAINS[state.to].name}`
                : activate
                  ? 'Sign the Stellar setup'
                  : 'Bridge to Stellar';

  el.steps.forEach((step, i) => step.classList.toggle('on', ready && i === 0));
}

el.connectEvm.addEventListener('click', connectEvm);
el.connectStellar.addEventListener('click', connectStellar);
el.dest.addEventListener('input', () => {
  clearTimeout(el.dest._t);
  el.dest._t = setTimeout(checkDestination, 300);
});
el.amount.addEventListener('input', render);
el.max.addEventListener('click', () => {
  if (state.balance === null) return;
  el.amount.value = formatUsdc(state.balance).replace(/,/g, '');
  render();
});

// --------------------------------------------------------------------------
// Which way, and between what
// --------------------------------------------------------------------------

/**
 * Reads the two pickers and tells the rest of the page what it is looking at.
 *
 * A route is a contract on one side and a watcher that knows how to finish on
 * the other, not a pair of chains that both exist. So a pair that is not built
 * says so plainly rather than letting somebody get as far as signing.
 */
function pickedRoute() {
  const from = el.fromChain.value;
  const to = el.toChain.value;
  return { from, to, status: routeStatus(from, to) };
}

function onChainChange(which) {
  return () => {
    const from = el.fromChain.value;
    const to = el.toChain.value;

    // Picking the same chain twice is a mistake nobody means to make, so the
    // other end moves out of the way rather than an error appearing.
    if (from === to) {
      const other = which === 'from' ? 'toChain' : 'fromChain';
      const away = Object.keys(CHAINS).find((id) => id !== from && CHAINS[id].live);
      if (away) el[other].value = away;
    }

    state.from = el.fromChain.value;
    state.to = el.toChain.value;
    checkDestination();
    render();
  };
}

fillChainPicker(el.fromChain, state.from);
fillChainPicker(el.toChain, state.to);
el.fromChain.addEventListener('change', onChainChange('from'));
el.toChain.addEventListener('change', onChainChange('to'));

el.swap.addEventListener('click', () => {
  const from = el.fromChain.value;
  el.fromChain.value = el.toChain.value;
  el.toChain.value = from;
  state.from = el.fromChain.value;
  state.to = el.toChain.value;

  // The address field means a different thing in each direction, and carrying
  // a Stellar address over into a field wanting an EVM one is a typo waiting
  // to be signed.
  el.dest.value = '';
  state.inspection = null;
  el.dest.placeholder =
    CHAINS[state.to].family === 'stellar'
      ? 'G… or M… for an exchange deposit'
      : '0x… on ' + CHAINS[state.to].name;
  checkDestination();
  render();
});

el.net.textContent = CONFIG.network;
setStatus('idle');
render();

// --------------------------------------------------------------------------
// Making the transfer
//
// The order is the design, and it is the same order `flow.js` enforces on the
// far side. The signature comes first because afterwards the user may be
// gone; the burn comes second because it is the point of no return; the post
// comes third because until the watcher holds the signed setup it cannot
// finish the job.
//
// What the watcher hands back to be signed is deliberately incomplete — it
// carries the channel's signature and not the funder's. So a user who signs
// and never burns is holding a transaction that cannot create anything.
// --------------------------------------------------------------------------

async function api(path, body) {
  let response;
  try {
    response = await fetch(`${CONFIG.api}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // `fetch` says "Failed to fetch" for a server that is not running, a
    // browser that blocked the request, and a network that is not there. It
    // is the same three words for three different jobs, so the sentence has
    // to name what was being reached for.
    throw new Error(
      `Could not reach the bridge service at ${CONFIG.api}. ` +
        (CONFIG.api.startsWith('http://') && location.protocol === 'https:'
          ? 'This page is served over https and the service is not, which browsers refuse. ' +
            'Open the page from the same machine over http, or put the service behind https.'
          : 'It may not be running.'),
    );
  }
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function sendEvm(to, data) {
  return state.evmProvider.request({
    method: 'eth_sendTransaction',
    params: [{ from: state.evm, to, data }],
  });
}

async function waitForReceipt(hash) {
  for (let i = 0; i < 60; i += 1) {
    const receipt = await state.evmProvider.request({
      method: 'eth_getTransactionReceipt',
      params: [hash],
    });
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('the transaction did not confirm');
}

/**
 * Out of Stellar, into an EVM chain.
 *
 * Shorter than the way in because there is nothing to build at the far end.
 * The burn is the only thing signed, and the user is the source of their own
 * transaction — they hold USDC on Stellar, so they hold the XLM that lets
 * them, and nothing of ours is at stake before the burn lands.
 */
async function bridgeOut() {
  const amount = parseUsdc(el.amount.value);
  const recipient = el.dest.value.trim();

  el.go.disabled = true;
  try {
    setStatus('working', 'Preparing the burn…');
    // Stellar carries seven decimals where the EVM side carries six.
    const built = await api('/outbound', {
      from: state.stellar,
      amount: (amount * 10n).toString(),
      recipient,
    });
    if (built.status !== 200) throw new Error(built.body.error || 'could not prepare the burn');

    setStatus('working', 'Sign the burn in Freighter…');
    const xdr = await signWithStellar(state.stellarWallet, built.body.xdr, {
      networkPassphrase: CONFIG.stellar.passphrase,
      address: state.stellar,
    });

    setStatus('working', 'Burning on Stellar…');
    const sent = await fetch(`${CONFIG.stellar.soroban}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: { transaction: xdr },
      }),
    });
    const result = (await sent.json()).result ?? {};
    if (result.status === 'ERROR') throw new Error('the burn was rejected');

    setStatus('done', `Burned. The bridge will claim it on ${CHAINS[state.to].name}.`);
  } catch (error) {
    setStatus('idle');
    setError(error);
    el.go.disabled = false;
  }
}

async function bridge() {
  if (CHAINS[state.from].family === 'stellar') return bridgeOut();

  const amount = parseUsdc(el.amount.value);
  const recipient = el.dest.value.trim();
  const activate = state.inspection?.needs !== 'nothing';

  el.go.disabled = true;
  try {
    // 1. The setup, and the user's signature on it. Nothing has been spent at
    //    this point, by them or by us.
    let setupXdr = null;
    if (activate) {
      setStatus('working', 'Preparing the Stellar setup…');
      const built = await api('/setup', { recipient });
      if (built.status !== 200) throw new Error(built.body.error || 'could not prepare the setup');

      if (built.body.xdr) {
        // Read it before handing it over. The setup is built on the server —
        // a page cannot know the channel's sequence number — so this is the
        // check that a tampered watcher cannot ask for a payment and have it
        // signed. Freighter would show it; this refuses before Freighter is
        // even asked.
        assertOnlyAskingForTrustline(parseEnvelope(built.body.xdr), {
          user: recipient,
          assetCode: 'USDC',
          issuer: CONFIG.stellar.usdcIssuer,
        });

        setStatus('working', 'Sign the setup in Freighter…');
        setupXdr = await signWithStellar(state.stellarWallet, built.body.xdr, {
          networkPassphrase: CONFIG.stellar.passphrase,
          address: state.stellar,
        });
      }
    }

    // 2. Approve, then burn. Committed from here.
    setStatus('working', 'Approving USDC…');
    const approve = encodeApprove(CONFIG.bridge, amount);
    await waitForReceipt(await sendEvm(CONFIG.base.usdc, approve));

    setStatus('working', 'Burning on Base…');
    const txHash = await sendEvm(
      CONFIG.bridge,
      encodeBridge(amount, recipient, activate, CONFIG.activationFee),
    );
    await waitForReceipt(txHash);

    // 3. Hand it over. The watcher re-reads the burn itself before it spends
    //    anything, so this is a shortcut and not a source of truth — the log
    //    would find it anyway, just without the signature.
    setStatus('working', 'Telling the bridge…');
    for (let i = 0; i < 10; i += 1) {
      const posted = await api('/transfers', { txHash, recipient, setupXdr });
      if (posted.status === 200) break;
      if (posted.status !== 202) throw new Error(posted.body.error || 'the bridge refused it');
      await new Promise((r) => setTimeout(r, 2000));
    }

    setStatus('done', 'Burned. Watching for delivery…');
    watchDelivery(txHash);
  } catch (error) {
    setStatus('idle');
    setError(error);
    el.go.disabled = false;
  }
}

async function watchDelivery(txHash) {
  for (let i = 0; i < 120; i += 1) {
    const { status, body } = await api(`/transfers/${txHash}`);
    if (status === 200 && body.delivered) {
      setStatus(
        'done',
        `Delivered. <a href="${CONFIG.stellar.explorer}/tx/${body.deliveredAt.stellarTxHash}" target="_blank" rel="noopener">See it on Stellar</a>`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  setStatus('done', 'Still waiting on Circle. It will arrive; this page need not stay open.');
}

el.go.addEventListener('click', bridge);
