import test from 'node:test';
import assert from 'node:assert/strict';

import { inspect, toStroops, formatStroops } from '../src/stellar/account.js';
import { USDC } from '../src/config.js';

const HORIZON = 'https://horizon.example';
const ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const asset = USDC.public;

/** Horizon's answers, as Horizon actually shapes them. */
function stub({ account, status = 200 }) {
  return async (url) => {
    if (url.includes('/ledgers')) {
      return json({ _embedded: { records: [{ base_reserve_in_stroops: 5_000_000 }] } });
    }
    if (status === 404) return json({ status: 404 }, 404);
    return json(account);
  };
}

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('an address with no account needs everything, and costs 1.5 XLM', async () => {
  const result = await inspect(HORIZON, ADDRESS, asset, { fetchImpl: stub({ status: 404 }) });

  assert.equal(result.exists, false);
  assert.equal(result.needs, 'account+trustline');
  // Two base reserves for the account plus one for the trustline.
  assert.equal(result.reserveXlm, '1.5');
});

test('an account without the trustline needs only that, and costs 0.5 XLM', async () => {
  const result = await inspect(HORIZON, ADDRESS, asset, {
    fetchImpl: stub({ account: { balances: [{ asset_type: 'native', balance: '3.0000000' }] } }),
  });

  assert.equal(result.exists, true);
  assert.equal(result.hasTrustline, false);
  assert.equal(result.needs, 'trustline');
  assert.equal(result.reserveXlm, '0.5');
});

test('an account already set up costs nothing, which is the common case', async () => {
  const result = await inspect(HORIZON, ADDRESS, asset, {
    fetchImpl: stub({
      account: {
        balances: [
          { asset_type: 'native', balance: '3.0000000' },
          {
            asset_code: 'USDC',
            asset_issuer: asset.getIssuer(),
            balance: '10.0000000',
            limit: '1000.0000000',
            is_authorized: true,
          },
        ],
      },
    }),
  });

  assert.equal(result.needs, 'nothing');
  assert.equal(result.reserveXlm, '0');
  assert.equal(result.headroom, '990');
  assert.equal(result.deliverable, true);
});

test('a lookalike USDC from another issuer is not the trustline we need', async () => {
  const result = await inspect(HORIZON, ADDRESS, asset, {
    fetchImpl: stub({
      account: {
        balances: [
          {
            asset_code: 'USDC',
            asset_issuer: 'GA22K667OGPC3R32NRJTNQG4KWT2OFGHNNGZ2JQMSIGLT7AFHVIOMJ43',
            balance: '0.0000000',
            limit: '1000.0000000',
          },
        ],
      },
    }),
  });

  assert.equal(result.hasTrustline, false, 'Horizon is full of USDC that is not Circle USDC');
  assert.equal(result.needs, 'trustline');
});

test('a transfer that would breach the trustline limit is caught before the burn', async () => {
  const account = {
    balances: [
      {
        asset_code: 'USDC',
        asset_issuer: asset.getIssuer(),
        balance: '995.0000000',
        limit: '1000.0000000',
        is_authorized: true,
      },
    ],
  };

  const fits = await inspect(HORIZON, ADDRESS, asset, { amount: '5', fetchImpl: stub({ account }) });
  assert.equal(fits.deliverable, true, 'exactly at the limit still lands');

  const overflows = await inspect(HORIZON, ADDRESS, asset, {
    amount: '5.0000001',
    fetchImpl: stub({ account }),
  });
  assert.equal(overflows.deliverable, false, 'one stroop past it does not');
});

test('an unauthorised trustline is reported rather than assumed fine', async () => {
  const result = await inspect(HORIZON, ADDRESS, asset, {
    fetchImpl: stub({
      account: {
        balances: [
          {
            asset_code: 'USDC',
            asset_issuer: asset.getIssuer(),
            balance: '0.0000000',
            limit: '1000.0000000',
            is_authorized: false,
          },
        ],
      },
    }),
  });

  assert.equal(result.authorized, false);
});

test('seven decimals survive the round trip', () => {
  // Stellar carries seven decimals and the EVM side six, so anything that
  // rounds here is money that quietly disappears.
  for (const value of ['0', '1', '0.0000001', '995.5', '1000000.1234567']) {
    assert.equal(formatStroops(toStroops(value)), value === '0' ? '0' : value);
  }
  assert.equal(toStroops('1').toString(), '10000000');
  assert.equal(toStroops('0.0000001').toString(), '1');
});
