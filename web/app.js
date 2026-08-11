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
import { parseEnvelope, assertOnlyAskingForTrustline, assertBurnsYourOwnUsdc } from './envelope.js';
import { CHAINS, routeStatus, fillChainPicker } from './chains.js';
import * as history from './history.js';
import {
  discoverEvmWallets,
  discoverStellarWallets,
  stellarAddress,
  signWithStellar,
} from './wallets.js';

/**
 * Where the watcher is.
 *
 * Derived from this page's own origin when it is being served locally, so a
 * second machine on the same network reaches the watcher on the machine that
 * served it the page rather than looking for one on itself, which is what
 * `localhost` means over there, and it is empty.
 *
 * Derived, and specifically not read from the URL. This page signs whatever
 * transaction that origin hands back, so a `?api=` would let somebody send a
 * link to the real page with a hostile watcher behind it. The page's own
 * origin carries no such invitation: anyone who can change it already serves
 * the page.
 */
function watcherOrigin() {
  const { protocol, hostname } = window.location;

  // Anything served over http is a local arrangement, the deployment is
  // https, so the watcher is on the same host, on its own port.
  if (protocol === 'http:') return `http://${hostname}:8787`;

  // Served over https, so this is the deployment and the watcher is the
  // hosted one. It answers on 8788 there, behind Caddy, because 8787 was
  // already taken on that machine.
  return 'https://stellargateapi.duckdns.org';
}

const CONFIG = {
  network: 'testnet',

  // Filled in after deployment. Empty on purpose until then.
  bridge: '0x69752D7C3d1c7C919bc24e34cD440762F642FF00',

  // Where the watcher listens. It builds the setup, the channel's sequence
  // number and the funder's address are not the browser's business, and it
  // takes the signed one back afterwards.
  //
  // Fixed here on purpose, and deliberately not read from the URL. This page
  // signs whatever transaction that origin hands it, so a `?api=` override
  // would be an invitation: point somebody at the real page with a hostile
  // watcher behind it and Freighter is asked to sign whatever it likes. The
  // origin has to be as fixed as the contract address, and it is listed in
  // the CSP for the same reason.
  //
  // The hosted watcher is at stellargateapi.duckdns.org, and it is named in
  // `connect-src` in vercel.json as well. Serving the page over http still
  // reaches a local one, which is what a second machine on the network needs.
  api: watcherOrigin(),

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

    // The Soroban side, going out. Pinned here for the same reason the API
    // origin is: the page checks the burn it is about to sign against this,
    // and asking the watcher which contract it meant would let a tampered one
    // name its own and answer its own exam.
    bridgeContract: 'CCWMXUFXXYL6HEL4BYXRPLUXPGI2DEYEOP7TZX7EXWZBOM7WAWWDMWHR',
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
  historyCard: $('historyCard'),
  historyList: $('historyList'),
  destLabel: $('destLabel'),
  qArrives: $('qArrives'),
  fromWho: $('fromWho'),
  toWho: $('toWho'),
  connectFrom: $('connectFrom'),
  connectTo: $('connectTo'),
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
  evmName: null,
  /// The provider the user picked, not whichever one wrote to window first.
  evmProvider: null,
  evm: null,
  stellar: null,
  balance: null, // BigInt, six decimals
  inspection: null, // from Horizon
  checking: false,
  /// Set while a transfer is running, so `render` leaves the step panel alone.
  transferring: false,
  /// Which wording the step panel is currently showing, to avoid redrawing it.
  stepsFor: null,
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
  // Kept apart from the Stellar one because there is no checksum to appeal to:
  // EIP-55 is about capitalisation and says nothing once something has been
  // lowercased, so all that can honestly be checked is the shape.
  nothing: ['is-ok', '✓', '<b>Ready to receive.</b><span class="sub">This account already holds USDC. Nothing to set up and nothing extra to pay.</span>'],
  trustline: ['is-ok', '✓', '<b>We will add the USDC trustline.</b><span class="sub">Your account covers its own half XLM reserve, so this costs you nothing beyond the bridge fee.</span>'],
  fund: ['is-warn', '+', '<b>This address cannot hold USDC yet.</b><span class="sub">We will send it 3 XLM so it can, and add the trustline. Charged once, and only to addresses that need it.</span>'],
  error: ['is-bad', '!', '<b>Could not reach Horizon.</b><span class="sub">The address may still be fine; we simply could not check it just now.</span>'],
};

/**
 * The kinds a status can be, for the ones that carry their own sentence.
 *
 * {STATUS} above is the presets, a fixed situation with fixed wording. These
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
 * was, the click worked, the first line of work threw, and the error went
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

/**
 * A connected wallet stays clickable, because a wallet you cannot leave is a
 * wallet you are stuck in. Somebody with three accounts will want a different
 * one, and the only alternative on offer was reloading the page.
 */
function showConnected(button, label) {
  button.classList.add('on');
  button.disabled = false;
  button.innerHTML = '';
  button.append(document.createTextNode(label));
  const drop = document.createElement('span');
  drop.className = 'drop';
  drop.textContent = 'disconnect';
  button.append(drop);
}

function showDisconnected(button, label) {
  button.classList.remove('on');
  button.disabled = false;
  button.textContent = label;
}

/**
 * Forgets a wallet.
 *
 * Only here, a page cannot revoke anything at the wallet's end, and
 * pretending otherwise would be a lie about who holds what. What it can do is
 * stop using it, which is what somebody means when they ask to disconnect.
 */
function disconnectEvm() {
  state.evmProvider = null;
  state.evm = null;
  state.balance = null;
  renderSides();
  readBalance();
  render();
}

function disconnectStellar() {
  state.stellarWallet = null;
  state.stellar = null;
  renderSides();
  readBalance();
  render();
}

/**
 * The address for a chain, and where to go and look at it.
 *
 * The page was written when there was one direction, so which wallet belonged
 * on which side was a fact rather than a question. Adding the picker turned it
 * into a question, and everything that had been answering it by position kept
 * answering the old way, an EVM address under "From · Stellar" and a `G…`
 * under "To · Base".
 */
function walletFor(chainId) {
  const chain = CHAINS[chainId];
  if (!chain) return null;
  if (chain.family === 'stellar') {
    return state.stellar && { address: state.stellar, href: `${CONFIG.stellar.explorer}/account/${state.stellar}` };
  }
  return state.evm && { address: state.evm, href: `${CONFIG.base.explorer}/address/${state.evm}` };
}

function showSide(node, chainId) {
  const wallet = walletFor(chainId);
  node.innerHTML = '';
  if (!wallet) {
    node.textContent = 'not connected';
    node.classList.add('empty');
    return;
  }
  const link = document.createElement('a');
  link.href = wallet.href;
  link.target = '_blank';
  link.rel = 'noopener';
  // Enough of an address to tell two accounts in the same wallet apart. Four
  // characters at each end is not, and reads as reassurance.
  link.textContent = `${wallet.address.slice(0, 10)}…${wallet.address.slice(-8)}`;
  node.append(link);
  node.classList.remove('empty');
}

/** Which wallet answers for a chain, and whether it is connected. */
function walletStateFor(chainId) {
  const family = CHAINS[chainId]?.family;
  return family === 'stellar'
    ? { connected: Boolean(state.stellar), name: state.stellarWallet?.name }
    : { connected: Boolean(state.evm), name: state.evmName };
}

/**
 * The buttons belong to the ends, not to the wallets.
 *
 * They were bound by position, the left one always EVM, the right one always
 * Stellar, which is the same assumption the addresses were making. Swapping
 * the direction left "Rabby connected" sitting under "From · Stellar" and a
 * Connect button that would have asked for the wallet already in use on the
 * other side.
 */
function renderConnects() {
  for (const [button, chainId] of [
    [el.connectFrom, state.from],
    [el.connectTo, state.to],
  ]) {
    const wallet = walletStateFor(chainId);
    if (wallet.connected) showConnected(button, `${wallet.name ?? 'Wallet'} connected`);
    else showDisconnected(button, `Connect on ${CHAINS[chainId]?.name ?? '…'}`);
  }
}

function renderSides() {
  showSide(el.fromWho, state.from);
  showSide(el.toWho, state.to);
  renderConnects();
}

/**
 * Offers the connected wallet's address as the destination, when it is one.
 *
 * Only when the wallet is on the receiving end. This filled the field
 * unconditionally, from the days when the Stellar wallet was always the
 * destination, so turning the bridge around dropped a `G…` into a box asking
 * for an `0x…` and then told the user it was not one.
 *
 * Left editable either way: an exchange deposit goes to a different address
 * than the one in the wallet, which is the case the muxed `M…` exists for.
 */
function prefillDestination() {
  if (el.dest.value) return;

  const wallet = walletFor(state.to);
  if (!wallet) return;

  el.dest.value = wallet.address;
  checkDestination();
}

/** Connects, or disconnects, whichever wallet that end needs. */
function connectSide(side) {
  const family = CHAINS[state[side]]?.family;
  return family === 'stellar' ? connectStellar() : connectEvm();
}

async function connectEvm() {
  if (state.evm) return disconnectEvm();
  const wallets = await discoverEvmWallets();
  const picked = await chooseWallet(
    'Choose a wallet',
    wallets,
    'No wallet announced itself. Install one, Rabby and MetaMask both work, then reload.',
  );
  if (!picked) return;

  const provider = picked.provider;
  const [account] = await provider.request({ method: 'eth_requestAccounts' });
  state.evmProvider = provider;
  state.evm = account;
  state.evmName = picked.name;

  // A wallet connected to some other chain answers `eth_call` from that chain,
  // which is how "could not read your balance" happens to somebody whose
  // balance is fine. Ask, and offer to move.
  try {
    await ensureChain(provider);
  } catch (error) {
    el.balance.textContent = String(error?.message ?? error);
  }
  renderSides();
  prefillDestination();

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

/**
 * How much USDC is on the chain being spent from.
 *
 * Which chain that is depends on the direction, and reading the wrong one is
 * not a cosmetic error: it is the number the Max button fills in and the one
 * a person checks their transfer against.
 */
async function readBalance() {
  state.balance = null;
  const source = CHAINS[state.from];
  const network = CONFIG.network === 'testnet' ? `${source.name} testnet` : source.name;

  const holder = source.family === 'stellar' ? state.stellar : state.evm;
  if (!holder) {
    el.balance.textContent = `Connect a wallet on ${source.name} to see your balance.`;
    return;
  }

  try {
    if (source.family === 'stellar') {
      // Horizon rather than the wallet: a Stellar wallet is a key and a
      // signature, and the ledger is what knows the balance.
      const response = await fetch(`${CONFIG.stellar.horizon}/accounts/${holder}`);
      if (response.status === 404) {
        el.balance.textContent = `That account does not exist on ${network} yet, so it holds nothing.`;
        state.balance = 0n;
        render();
        return;
      }
      if (!response.ok) throw new Error(`Horizon answered ${response.status}`);

      const account = await response.json();
      const line = (account.balances ?? []).find(
        (b) => b.asset_code === 'USDC' && b.asset_issuer === CONFIG.stellar.usdcIssuer,
      );
      // Stellar carries seven decimals where the EVM side carries six, and
      // this page counts in six throughout.
      state.balance = line ? BigInt(Math.round(Number(line.balance) * 1e6)) : 0n;
    } else {
      const data = `0x70a08231000000000000000000000000${holder.slice(2)}`;
      const result = await state.evmProvider.request({
        method: 'eth_call',
        params: [{ to: CONFIG.base.usdc, data }, 'latest'],
      });
      state.balance = BigInt(result);
    }

    el.balance.textContent =
      state.balance === 0n
        ? `No USDC on ${network} in this account. That is the balance, not a failure to read it, testnet USDC comes from Circle's faucet.`
        : `${formatUsdc(state.balance)} USDC on ${network}.`;
  } catch (error) {
    // Saying only "could not" sends people looking at their balance, which is
    // the one thing that is fine.
    el.balance.textContent = `Could not read your USDC balance on ${network}: ${
      error?.message ?? error
    }`;
  }
  render();
}

async function connectStellar() {
  if (state.stellar) return disconnectStellar();

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
    renderSides();

    prefillDestination();
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
  // no trustline to add, and no checksum worth trusting, EIP-55 is about
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
        ', you will need its own currency before you can move what lands there.</span>',
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
    el.qSend.textContent = ', ';
    el.qFee.textContent = ', ';
    el.qGet.textContent = ', ';
    el.qActRow.hidden = true;
  } else {
    const { fee, activation, net } = quote(amount, activate);
    el.qSend.textContent = `${formatUsdc(amount)} USDC`;
    el.qFee.textContent = `${formatUsdc(fee - activation)} USDC`;
    // Nothing is activated on the way out: an EVM address exists whether
    // anyone has heard of it or not, so the row would be a charge that cannot
    // happen.
    el.qActRow.hidden = !activate || CHAINS[state.from].family === 'stellar';
    el.qAct.textContent = `${formatUsdc(activation)} USDC`;
    el.qGet.textContent = net > 0n ? `${formatUsdc(net)} USDC` : ', ';
  }

  const route = pickedRoute();
  const outbound = CHAINS[state.from].family === 'stellar';

  // The words for the ends, rather than the ones the page started life with.
  el.destLabel.textContent = `${CHAINS[state.to].name} address`;
  el.qArrives.textContent = `Arrives on ${CHAINS[state.to].name}`;
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

  // Only while nothing is in flight. `render` runs on every keystroke and on
  // every history redraw, so without this a transfer's progress would be wiped
  // by an event that has nothing to do with it.
  if (!state.transferring) {
    drawSteps(outbound ? 'out' : 'in');
    showProgress(ready ? 0 : -1);
  }
}

/**
 * The four steps, as somewhere you are rather than a list of what happens.
 *
 * `completed` is how many are behind you: those go green, the next one is
 * yellow, the rest stay plain. Passing the count rather than an index means
 * finishing is `showProgress(4)` and nothing has to special case the end.
 *
 * The styles for this existed from the start and nothing drove them, so the
 * panel lit step one and then said the same thing for the whole transfer.
 */
function showProgress(completed) {
  el.steps.forEach((step, i) => {
    step.classList.toggle('done', i < completed);
    step.classList.toggle('on', i === completed);
  });
}

/**
 * What the four steps say, which is not the same thing in both directions.
 *
 * Going out there is no account to build and no setup to sign, so the panel
 * described a flow that was not happening: step three offered to set up a
 * Stellar account the user already has and is leaving. Each line here is one
 * transition in the code rather than a stage of a story, so a step going green
 * means something observable happened.
 */
const STEPS = {
  in: [
    ['Sign the Stellar setup', 'Costs nothing. Nothing has happened yet if you stop here.'],
    ['Burn the USDC on Base', 'This is the step that commits your money.'],
    ['We set up your Stellar account', 'Done while Circle attests, so it costs you no extra wait.'],
    [
      'USDC arrives',
      "Under a minute. Stellar does take Circle's fast transfers, whatever the documentation reads like.",
    ],
  ],
  out: [
    ['Build the burn', 'We put it together. Nothing is signed and nothing has moved.'],
    ['Sign the burn in Freighter', 'This is the step that commits your money.'],
    ['The burn lands on Stellar', "Seconds. Stellar's own finality was never the slow part."],
    ['We claim it on Base', 'Anyone may call receiveMessage. Somebody has to, so it is us.'],
  ],
};

/** Redraws the step wording, and only when the direction has actually changed. */
function drawSteps(direction) {
  if (state.stepsFor === direction) return;

  let drew = false;
  STEPS[direction].forEach(([title, detail], i) => {
    // A panel that is not there is not worth throwing over: this runs from
    // `render`, and `render` running is the difference between a page and a
    // static document.
    const text = el.steps[i]?.querySelector?.('.t');
    if (!text) return;

    text.textContent = title;
    const small = document.createElement('small');
    small.textContent = detail;
    text.appendChild(small);
    drew = true;
  });

  // Remembered only if it happened, so a panel that arrives late still gets
  // its words rather than being marked done with the wrong ones.
  if (drew) state.stepsFor = direction;
}

// --------------------------------------------------------------------------
// What this browser has sent
// --------------------------------------------------------------------------

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });

function explorerFor(entry) {
  return entry.direction === 'out'
    ? `${CONFIG.stellar.explorer}/tx/${entry.txHash}`
    : `${CONFIG.base.explorer}/tx/${entry.txHash}`;
}

/**
 * Draws the list, and asks the watcher about anything still in flight.
 *
 * Only the unfinished ones are asked about: a delivery is a fact about a chain
 * and does not become untrue, so once it is recorded there is nothing left to
 * learn and no reason to keep asking.
 */
async function renderHistory() {
  const entries = history.all();
  el.historyCard.hidden = entries.length === 0;
  el.historyList.innerHTML = '';

  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'hrow';

    const way = document.createElement('span');
    way.className = 'way';
    way.textContent = `${CHAINS[entry.from]?.name ?? entry.from} → ${
      CHAINS[entry.to]?.name ?? entry.to
    }`;

    const amount = document.createElement('span');
    amount.className = 'amt';
    amount.textContent = `${entry.amount} USDC`;

    const state_ = document.createElement('span');
    state_.className = `state ${entry.delivered ? 'ok' : 'waiting'}`;
    state_.textContent = entry.delivered ? 'delivered' : 'in flight';

    const seen = document.createElement('a');
    seen.href = explorerFor(entry);
    seen.target = '_blank';
    seen.rel = 'noopener';
    seen.textContent = 'burn';

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = WHEN.format(new Date(entry.at));

    row.append(way, amount, state_, seen, when);
    el.historyList.append(row);
  }

  for (const entry of entries.filter((e) => !e.delivered)) {
    try {
      const { status, body } = await api(`/transfers/${entry.txHash}`);
      if (status === 200 && body.delivered) {
        history.settle(entry.txHash, body.deliveredAt ?? true);
        renderHistory();
        return;
      }
    } catch {
      // The watcher being unreachable is not news the history should shout
      // about; the rows are already drawn from what is known.
    }
  }
}

el.connectFrom.addEventListener('click', () => connectSide('from'));
el.connectTo.addEventListener('click', () => connectSide('to'));
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
    afterDirectionChange();
  };
}

/**
 * Everything that stops being true when the direction moves.
 *
 * The address field means a different thing at each end, the balance is on a
 * different chain, and which wallet sits on which side has swapped. Carrying
 * any of it over is how a `G…` ends up in a field wanting an `0x…`.
 */
function afterDirectionChange() {
  el.dest.value = '';
  el.dest.classList.remove('bad');
  state.inspection = null;
  el.dest.placeholder =
    CHAINS[state.to].family === 'stellar'
      ? 'G… or M… for an exchange deposit'
      : `0x… on ${CHAINS[state.to].name}`;

  setStatus('idle');
  renderSides();
  readBalance();
  prefillDestination();
  checkDestination();
  render();
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
  afterDirectionChange();
});

renderHistory();
renderSides();

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
// What the watcher hands back to be signed is deliberately incomplete, it
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
 * transaction, they hold USDC on Stellar, so they hold the XLM that lets
 * them, and nothing of ours is at stake before the burn lands.
 */
async function bridgeOut() {
  const amount = parseUsdc(el.amount.value);
  const recipient = el.dest.value.trim();

  el.go.disabled = true;
  state.transferring = true;
  showProgress(0);
  try {
    setStatus('working', 'Preparing the burn…');
    // Stellar carries seven decimals where the EVM side carries six.
    const built = await api('/outbound', {
      from: state.stellar,
      amount: (amount * 10n).toString(),
      recipient,
    });
    if (built.status !== 200) throw new Error(built.body.error || 'could not prepare the burn');

    // Read it before handing it over, the same defence the inbound setup has.
    // It matters more here: Freighter renders a Soroban call as a contract id
    // and a blob of arguments, so telling the user to check it themselves is
    // advice nobody can act on. A tampered watcher could return a call moving
    // the whole balance somewhere else and it would look identical.
    assertBurnsYourOwnUsdc(parseEnvelope(built.body.xdr), {
      user: state.stellar,
      contractId: CONFIG.stellar.bridgeContract,
      amount: amount * 10n,
      recipient,
    });
    showProgress(1);

    setStatus('working', 'Sign the burn in Freighter…');
    const xdr = await signWithStellar(state.stellarWallet, built.body.xdr, {
      networkPassphrase: CONFIG.stellar.passphrase,
      address: state.stellar,
    });
    showProgress(2);

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
    showProgress(3);

    history.remember({
      txHash: result.hash,
      direction: 'out',
      from: state.from,
      to: state.to,
      amount: formatUsdc(amount),
      recipient,
    });
    renderHistory();

    setStatus('done', `Burned. The bridge will claim it on ${CHAINS[state.to].name}.`);
    // The claim is recorded in the same store the way in uses, under this same
    // hash, so waiting for it is the same wait.
    watchDelivery(result.hash);
  } catch (error) {
    setStatus('idle');
    setError(error);
    el.go.disabled = false;
    state.transferring = false;
    render();
  }
}

async function bridge() {
  if (CHAINS[state.from].family === 'stellar') return bridgeOut();

  const amount = parseUsdc(el.amount.value);
  const recipient = el.dest.value.trim();
  // The same question the quote asks, asked the same way. These were two
  // expressions for one thing, the quote read `fundsUser`, this read "needs
  // anything at all", and they disagreed exactly where it costs money. An
  // account that exists and can pay its own trustline reserve needs no
  // activation; one was shown "Account activation 0.00" and charged three
  // dollars for one it neither needed nor received.
  const activate = state.inspection?.fundsUser === true;

  el.go.disabled = true;
  state.transferring = true;
  // An account that can pay its own way has nothing to sign, so step one is
  // already behind that user rather than something they have to watch.
  showProgress(activate ? 0 : 1);
  try {
    // 1. The setup, and the user's signature on it. Nothing has been spent at
    //    this point, by them or by us.
    let setupXdr = null;
    if (activate) {
      setStatus('working', 'Preparing the Stellar setup…');
      const built = await api('/setup', { recipient });
      if (built.status !== 200) throw new Error(built.body.error || 'could not prepare the setup');

      if (built.body.xdr) {
        // Read it before handing it over. The setup is built on the server, // a page cannot know the channel's sequence number, so this is the
        // check that a tampered watcher cannot ask for a payment and have it
        // signed. Freighter would show it; this refuses before Freighter is
        // even asked.
        assertOnlyAskingForTrustline(parseEnvelope(built.body.xdr), {
          user: recipient,
          assetCode: 'USDC',
          issuer: CONFIG.stellar.usdcIssuer,
        });

        // Freighter will say the account cannot afford the fee. It cannot,
        // and it is not paying it: the transaction is sourced from a channel
        // account of ours, and that is where the fee comes from. Freighter
        // judges by the account it is signing with and has no way to see
        // that, so the warning is certain to appear for exactly the people
        // this bridge is for, somebody with an empty Stellar account. Saying
        // so first is cheaper than having them stop there.
        setStatus(
          'working',
          '<b>Sign the setup in your wallet.</b><span class="sub">Your wallet may warn ' +
            'that you cannot afford the fee. You are not paying it, we are, and signing ' +
            'costs you nothing.</span>',
        );
        setupXdr = await signWithStellar(state.stellarWallet, built.body.xdr, {
          networkPassphrase: CONFIG.stellar.passphrase,
          address: state.stellar,
        });
      }
      showProgress(1);
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
    showProgress(2);

    // 3. Hand it over. The watcher re-reads the burn itself before it spends
    //    anything, so this is a shortcut and not a source of truth, the log
    //    would find it anyway, just without the signature.
    setStatus('working', 'Telling the bridge…');
    for (let i = 0; i < 10; i += 1) {
      const posted = await api('/transfers', { txHash, recipient, setupXdr });
      if (posted.status === 200) break;
      if (posted.status !== 202) throw new Error(posted.body.error || 'the bridge refused it');
      await new Promise((r) => setTimeout(r, 2000));
    }
    showProgress(3);

    history.remember({
      txHash,
      direction: 'in',
      from: state.from,
      to: state.to,
      amount: formatUsdc(amount),
      recipient,
    });
    renderHistory();

    setStatus('done', 'Burned. Watching for delivery…');
    watchDelivery(txHash);
  } catch (error) {
    setStatus('idle');
    setError(error);
    el.go.disabled = false;
    // Back to the start rather than frozen halfway: the burn either happened
    // or it did not, and a step left yellow would claim it is still going.
    state.transferring = false;
    render();
  }
}

async function watchDelivery(txHash) {
  for (let i = 0; i < 120; i += 1) {
    const { status, body } = await api(`/transfers/${txHash}`);
    if (status === 200 && body.delivered) {
      history.settle(txHash, body.deliveredAt);
      renderHistory();
      showProgress(4);
      state.transferring = false;
      // `stellarTxHash` is the store's name for it and it predates the way
      // out, where the hash it holds is the claim on Base. It is the far side
      // whichever way you went, so the link has to follow the destination
      // rather than the name.
      const arrival = CHAINS[state.to];
      const explorer =
        arrival.family === 'stellar' ? CONFIG.stellar.explorer : CONFIG.base.explorer;
      setStatus(
        'done',
        `Delivered. <a href="${explorer}/tx/${body.deliveredAt.stellarTxHash}" target="_blank" rel="noopener">See it on ${escapeHtml(arrival.name)}</a>`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  // Giving up watching is not the transfer failing, so the last step stays
  // yellow rather than green. Releasing the flag lets the next thing the user
  // does reset the panel, instead of leaving it locked on a transfer that is
  // no longer being followed.
  state.transferring = false;
  setStatus('done', 'Still waiting on Circle. It will arrive; this page need not stay open.');
}

el.go.addEventListener('click', bridge);
