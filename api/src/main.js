/**
 * Wiring. The only file here that knows about the environment.
 *
 * Everything it assembles is testable without it, which is the point: this
 * reads configuration, binds it to the pieces, and gets out of the way. If a
 * decision ends up in here it has escaped from somewhere it could be checked.
 */

import { createServer } from 'node:http';
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

import { CFG, network } from './config.js';
import { createHandler, listen } from './server.js';
import { Store } from './watcher/store.js';
import { Cursors } from './watcher/cursors.js';
import { verifyPaidBurn } from './watcher/burn.js';
import { IRIS, fetchAttestation } from './watcher/attestation.js';
import { deliver, FORWARDER } from './watcher/deliver.js';
import { submit } from './stellar/activation.js';
import { buildSetupFor } from './stellar/setup.js';
import { ChannelPool } from './stellar/channels.js';
import { assertSetupIsOurs } from './stellar/verify.js';
import { createLimiter } from './ratelimit.js';
import { buildOutbound as buildOutboundTx } from './stellar/outbound.js';
import { claimOnEvm, MESSAGE_TRANSMITTER, STELLAR_DOMAIN } from './watcher/reverse.js';
import { run } from './watcher/run.js';
import { createPulse } from './watcher/pulse.js';

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function assemble(env = process.env) {
  const chosen = network();
  const isTestnet = CFG.network === 'testnet';

  const rpc = env.BRIDGE_SOURCE_RPC || 'https://sepolia.base.org';
  const bridge = required(env, 'BRIDGE_CONTRACT');
  const sourceDomain = Number(env.BRIDGE_SOURCE_DOMAIN ?? 6);

  const signer = Keypair.fromSecret(required(env, 'BRIDGE_DELIVERY_SECRET'));
  const passphrase = isTestnet ? Networks.TESTNET : Networks.PUBLIC;

  const store = new Store({ path: env.BRIDGE_STORE || './transfers.json' });
  // Beside the store, and outside the code directory for the same reason it
  // is: deployment rsyncs `api/` with --delete, so a position kept in there
  // would be thrown away by the very restarts it exists to survive.
  const cursors = new Cursors({ path: env.BRIDGE_CURSORS || './cursors.json' });

  // Each dependency is the general function with this deployment's facts
  // already bound, so nothing downstream has to know where it is running.
  // How far behind the head a burn must be before XLM moves for it. A number
  // of blocks, or `safe` / `finalized` for the node's own tags. See
  // {confirmed} for why the default is blocks and not `safe`.
  const raw = env.BRIDGE_BURN_CONFIRMATIONS ?? '5';
  const confirmations = raw === 'safe' || raw === 'finalized' || raw === 'latest' ? raw : Number(raw);
  if (typeof confirmations === 'number' && !(Number.isInteger(confirmations) && confirmations >= 0)) {
    throw new Error(`BRIDGE_BURN_CONFIRMATIONS must be a block count, safe, or finalized, not ${raw}`);
  }

  const verifyBurn = (txHash, recipient) =>
    verifyPaidBurn(rpc, txHash, { bridge, expectedRecipient: recipient, confirmations });

  // What one caller, and everybody together, may ask per minute of the
  // routes that cost something. The second number is the one that protects
  // Horizon's per-address budget from a crowd.
  const limiter = createLimiter({
    perKey: { limit: Number(env.BRIDGE_RATE_PER_CALLER ?? 20), windowMs: 60_000 },
    global: { limit: Number(env.BRIDGE_RATE_EVERYONE ?? 300), windowMs: 60_000 },
  });

  const attest = (txHash) =>
    fetchAttestation(isTestnet ? IRIS.testnet : IRIS.public, sourceDomain, txHash);

  // The funder signs here and nowhere earlier: the setup that goes out to the
  // browser is short exactly this signature, so it cannot be submitted for
  // three XLM by anyone who never burned.
  const funder = env.BRIDGE_FUNDER_SECRET
    ? Keypair.fromSecret(env.BRIDGE_FUNDER_SECRET)
    : null;

  // Channels, plural. One is one sequence number, and two transfers in
  // flight at once were being handed the same one. `BRIDGE_CHANNEL_SECRET`
  // still works as a pool of one, for a deployment that has not caught up.
  const channelSecrets = (env.BRIDGE_CHANNEL_SECRETS || env.BRIDGE_CHANNEL_SECRET || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const channels = channelSecrets.length
    ? new ChannelPool(channelSecrets.map((s) => Keypair.fromSecret(s)), {
        // A hold outliving the transaction it protects is a channel idling;
        // one ending sooner is the collision the pool exists to prevent.
        holdSeconds: CFG.setupTimeoutSeconds,
      })
    : null;

  // What the funder may sign: a setup this server built, and nothing else.
  // Bound here so both callers, the door and the signing, check the same
  // thing against the same channels, funder, asset and amount.
  const verifySetup =
    channels && funder
      ? (setupXdr, recipient) =>
          assertSetupIsOurs(setupXdr, {
            networkPassphrase: passphrase,
            recipient,
            channelAccounts: channels.signers.map((s) => s.publicKey()),
            funderAddress: funder.publicKey(),
            asset: chosen.usdc,
            startingXlm: CFG.activationXlm,
          })
      : null;

  const submitSetup = async (signedXdr, paidBurn) => {
    // Checked again here, at the signature, not only at the door. The store
    // is a file on disk and the door is one HTTP handler; the funder's key
    // trusts neither.
    if (verifySetup) verifySetup(signedXdr, paidBurn?.stellarRecipient);

    const result = await submit(chosen.horizon, signedXdr, {
      networkPassphrase: passphrase,
      paidBurn,
      funderSigner: funder,
    });
    // Whatever Horizon said, this envelope is either applied or dead to the
    // sequence it carried, and the channel is free to be lent again. A retry
    // of the same envelope needs no reservation: its sequence is already
    // inside it.
    if (channels && (result.ok || result.alreadyDone || result.dead)) {
      channels.releaseAccount(TransactionBuilder.fromXDR(signedXdr, passphrase).source);
    }
    return result;
  };

  const buildSetup =
    channels && funder
      ? async (recipient, { amount } = {}) => {
          const channel = channels.reserve(recipient);
          try {
            const built = await buildSetupFor(recipient, {
              horizon: chosen.horizon,
              asset: chosen.usdc,
              networkPassphrase: passphrase,
              channelSigner: channel,
              funderAddress: funder.publicKey(),
              startingXlm: CFG.activationXlm,
              timeoutSeconds: CFG.setupTimeoutSeconds,
              baseFee: CFG.baseFee,
              amount,
            });
            // Nothing to sign means nothing holding a sequence number.
            if (!built) channels.release(recipient);
            return built;
          } catch (error) {
            channels.release(recipient);
            throw error;
          }
        }
      : null;

  const deliverMessage = (message, attestation) =>
    deliver({
      rpcUrl: env.BRIDGE_SOROBAN_RPC || 'https://soroban-testnet.stellar.org',
      networkPassphrase: passphrase,
      forwarderId: isTestnet ? FORWARDER.testnet : FORWARDER.public,
      signer,
      message,
      attestation,
    });

  // The other direction runs only where it is configured. A deployment with
  // no Soroban contract and no EVM key simply does not follow it, rather than
  // following it badly.
  const reverseContract = env.BRIDGE_REVERSE_CONTRACT || null;
  const evmKey = env.BRIDGE_CLAIM_PRIVATE_KEY || null;

  const reverse =
    reverseContract && evmKey
      ? {
          rpcUrl: env.BRIDGE_SOROBAN_RPC || 'https://soroban-testnet.stellar.org',
          contractId: reverseContract,
          startLedger: env.BRIDGE_REVERSE_LEDGER ? Number(env.BRIDGE_REVERSE_LEDGER) : null,
        }
      : null;

  // Circle attests the outbound burns under Stellar's domain, not ours.
  const attestOut = (txHash) =>
    fetchAttestation(isTestnet ? IRIS.testnet : IRIS.public, STELLAR_DOMAIN, txHash);

  const claim = (message, attestation) =>
    claimOnEvm({
      rpcUrl: rpc,
      privateKey: evmKey,
      transmitter: isTestnet ? MESSAGE_TRANSMITTER.testnet : MESSAGE_TRANSMITTER.public,
      message,
      attestation,
      testnet: isTestnet,
    });

  const buildOutbound = reverseContract
    ? ({ from, amount, recipient }) =>
        buildOutboundTx(
          { from, amount, recipient },
          {
            rpcUrl: env.BRIDGE_SOROBAN_RPC || 'https://soroban-testnet.stellar.org',
            contractId: reverseContract,
            networkPassphrase: passphrase,
          },
        )
    : null;

  return {
    store,
    cursors,
    rpc,
    bridge,
    channels,
    verifySetup,
    limiter,
    confirmations,
    buildOutbound,
    reverse,
    attestOut,
    claim,
    verifyBurn,
    attest,
    submitSetup,
    deliver: deliverMessage,
    buildSetup,
    port: Number(env.PORT ?? 8787),
    cursor: env.BRIDGE_CURSOR ? Number(env.BRIDGE_CURSOR) : undefined,
  };
}

export async function main(env = process.env) {
  const parts = assemble(env);
  const controller = new AbortController();

  // Shared between the follower and the health endpoint: one writes, the other
  // reads. It exists here rather than inside either of them because it is the
  // only thing they both need to see.
  const pulse = createPulse();

  const server = listen(createHandler({
      store: parts.store,
      verifyBurn: parts.verifyBurn,
      buildSetup: parts.buildSetup,
      buildOutbound: parts.buildOutbound,
      verifySetup: parts.verifySetup,
      limiter: parts.limiter,
      pulse,
    }), {
    port: parts.port,
    createServer,
    // Behind Caddy, which sets x-forwarded-for. Set to 0 when the watcher
    // faces the network directly, or the header is the caller's to write.
    trustProxy: env.BRIDGE_TRUST_PROXY !== '0',
  });

  const stop = () => {
    controller.abort();
    server.close();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // One line per event, as JSON, so whatever collects logs can filter rather
  // than parse prose.
  const log = (line) => console.log(JSON.stringify({ at: new Date().toISOString(), ...line }));
  log({ event: 'listening', port: parts.port, bridge: parts.bridge });

  await run({ ...parts, signal: controller.signal, log, pulse });
}

// Only when run directly, so importing this for tests starts nothing.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: 'fatal', reason: String(error?.message ?? error) }));
    process.exit(1);
  });
}
