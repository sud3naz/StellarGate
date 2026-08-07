/**
 * The one thing the browser has that the chain does not: the signed setup.
 *
 * Everything else the watcher needs it can read for itself — the burn is a log
 * on Base, the attestation is Circle's to give. But the transaction that
 * creates the user's account carries the user's own signature, taken in
 * Freighter before the burn, and if the tab closes without handing it over
 * there is no way to reconstruct it. So there is an endpoint, and its only
 * real job is to accept that XDR.
 *
 * It verifies before it records, which matters more than it looks. `remember`
 * refuses to file one burn against two addresses — sensible on its own, and a
 * griefing vector if anyone can file first: post a real transaction hash with
 * the wrong recipient and the legitimate transfer is locked out of its own
 * record. Checking the burn against the chain first closes that, because a
 * recipient the burn does not name never gets written down. No money was ever
 * at risk — spending is gated separately — but a user stuck behind somebody
 * else's lie is still a user who cannot be paid.
 */

import { UnpaidBurn } from './watcher/burn.js';
import { DoublePayment } from './watcher/store.js';

const json = (status, body) => ({ status, body });

/**
 * @param verifyBurn `(txHash, recipient) => proof | null`, from
 *        {verifyPaidBurn} with the RPC and bridge address bound.
 */
export function createHandler({ store, verifyBurn }) {
  return async function handle({ method, path, body }) {
    if (method === 'GET' && path === '/health') {
      return json(200, { ok: true, pending: store.pending().length });
    }

    if (method === 'POST' && path === '/transfers') {
      const { txHash, recipient, setupXdr } = body ?? {};
      if (!txHash || !recipient) {
        return json(400, { error: 'txHash and recipient are required' });
      }

      let proof;
      try {
        proof = await verifyBurn(txHash, recipient);
      } catch (error) {
        if (error instanceof UnpaidBurn) return json(400, { error: error.message });
        throw error;
      }

      // The receipt is not visible yet. Common in the seconds after a burn,
      // and not a refusal — the client should come back. Recording it now
      // would mean recording something unverified.
      if (!proof) {
        return json(202, { status: 'pending', retry: true, reason: 'burn not on chain yet' });
      }

      try {
        const transfer = store.remember({ txHash, recipient, setupXdr });
        return json(200, {
          status: 'accepted',
          txHash,
          recipient,
          activate: proof.activate,
          hasSetup: Boolean(transfer.setupXdr),
        });
      } catch (error) {
        if (error instanceof DoublePayment) return json(409, { error: error.message });
        throw error;
      }
    }

    if (method === 'GET' && path.startsWith('/transfers/')) {
      const txHash = path.slice('/transfers/'.length);
      const transfer = store.get(txHash);
      if (!transfer) return json(404, { error: 'unknown transfer' });

      return json(200, {
        txHash: transfer.txHash,
        recipient: transfer.recipient,
        hasSetup: Boolean(transfer.setupXdr),
        provisioned: transfer.provisioned,
        delivered: Boolean(transfer.deliveredAt),
        deliveredAt: transfer.deliveredAt,
      });
    }

    return json(404, { error: 'no such route' });
  };
}

/**
 * A node:http adapter, kept thin on purpose. The routing above is testable
 * without binding a port; this is the part that cannot be.
 */
export function listen(handle, { port = 8787, createServer } = {}) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);

    let parsed = null;
    if (chunks.length) {
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'body was not JSON' }));
        return;
      }
    }

    try {
      const url = new URL(req.url, 'http://localhost');
      const { status, body } = await handle({
        method: req.method,
        path: url.pathname,
        body: parsed,
      });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
  });

  server.listen(port);
  return server;
}
