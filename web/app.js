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
  fromWho: $('fromWho'),
  toWho: $('toWho'),
  connectEvm: $('connectEvm'),
  connectStellar: $('connectStellar'),
  amount: $('amount'),
  max: $('max'),
  balance: $('balance'),
  dest: $('dest'),
  status: $('status'),
  statusText: $('statusText'),
  qSend: $('qSend'),
  qFee: $('qFee'),
  qAct: $('qAct'),
  qActRow: $('qActRow'),
  qGet: $('qGet'),
  go: $('go'),
  steps: [$('s1'), $('s2'), $('s3'), $('s4')],
};

const state = {
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

function setStatus(key) {
  const [cls, icon, text] = STATUS[key];
  el.status.className = `status ${cls}`;
  el.status.innerHTML = `<span class="ic">${icon}</span><span>${text}</span>`;
}

// --------------------------------------------------------------------------
// Wallets
// --------------------------------------------------------------------------

async function connectEvm() {
  const provider = window.ethereum;
  if (!provider) {
    el.balance.textContent = 'No EVM wallet found. Rabby is the one we recommend.';
    return;
  }
  const [account] = await provider.request({ method: 'eth_requestAccounts' });
  state.evm = account;
  el.fromWho.textContent = `${account.slice(0, 6)}…${account.slice(-4)}`;
  el.fromWho.classList.remove('empty');
  el.connectEvm.textContent = 'Base connected';
  el.connectEvm.disabled = true;

  await readBalance();
  render();
}

async function readBalance() {
  if (!state.evm) return;
  try {
    const data = `0x70a08231000000000000000000000000${state.evm.slice(2)}`;
    const result = await window.ethereum.request({
      method: 'eth_call',
      params: [{ to: CONFIG.base.usdc, data }, 'latest'],
    });
    state.balance = BigInt(result);
    el.balance.textContent = `${formatUsdc(state.balance)} USDC available on Base.`;
  } catch {
    el.balance.textContent = 'Could not read your USDC balance.';
  }
}

async function connectStellar() {
  const api = window.freighterApi;
  if (!api) {
    setStatus('idle');
    el.statusText.textContent = 'Freighter not found. Install it, then reload.';
    return;
  }
  try {
    if (api.setAllowed) await api.setAllowed();
    const result = await (api.getAddress ? api.getAddress() : api.getPublicKey());
    const address = typeof result === 'string' ? result : result.address;

    state.stellar = address;
    el.toWho.textContent = `${address.slice(0, 6)}…${address.slice(-6)}`;
    el.toWho.classList.remove('empty');
    el.connectStellar.textContent = 'Freighter connected';
    el.connectStellar.disabled = true;

    // Prefill, but leave it editable: an exchange deposit needs a different
    // address than the one in the wallet.
    if (!el.dest.value) {
      el.dest.value = address;
      checkDestination();
    }
  } catch {
    /* the user declined; nothing to do */
  }
  render();
}

// --------------------------------------------------------------------------
// Wiring
// --------------------------------------------------------------------------

let checkToken = 0;

async function checkDestination() {
  const address = el.dest.value.trim().toUpperCase();
  el.dest.classList.remove('bad');
  state.inspection = null;

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

  const ready =
    state.evm && state.stellar && state.inspection && amount !== null && amount >= floor;

  el.go.disabled = !ready || !CONFIG.bridge;
  el.go.textContent = !state.evm || !state.stellar
    ? 'Connect both wallets to begin'
    : !state.inspection
      ? 'Enter a Stellar address'
      : amount === null || amount === 0n
        ? 'Enter an amount'
        : amount < floor
          ? `Minimum ${formatUsdc(floor)} USDC${activate ? ' with activation' : ''}`
          : !CONFIG.bridge
            ? 'Not deployed yet'
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
  const response = await fetch(`${CONFIG.api}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function sendEvm(to, data) {
  return window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from: state.evm, to, data }],
  });
}

async function waitForReceipt(hash) {
  for (let i = 0; i < 60; i += 1) {
    const receipt = await window.ethereum.request({
      method: 'eth_getTransactionReceipt',
      params: [hash],
    });
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('the transaction did not confirm');
}

async function bridge() {
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
        setStatus('working', 'Sign the setup in Freighter…');
        const signed = await window.freighterApi.signTransaction(built.body.xdr, {
          networkPassphrase: 'Test SDF Network ; September 2015',
          address: state.stellar,
        });
        setupXdr = typeof signed === 'string' ? signed : signed.signedTxXdr;
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
    el.statusText.textContent = String(error?.message ?? error);
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
