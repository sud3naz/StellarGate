/**
 * Wiring. The only file here that knows about the environment.
 *
 * Everything it assembles is testable without it, which is the point: this
 * reads configuration, binds it to the pieces, and gets out of the way. If a
 * decision ends up in here it has escaped from somewhere it could be checked.
 */

import { createServer } from 'node:http';
import { Keypair, Networks } from '@stellar/stellar-sdk';

import { CFG, network } from './config.js';
import { createHandler, listen } from './server.js';
import { Store } from './watcher/store.js';
import { verifyPaidBurn } from './watcher/burn.js';
import { IRIS, fetchAttestation } from './watcher/attestation.js';
import { deliver, FORWARDER } from './watcher/deliver.js';
import { submit } from './stellar/activation.js';
import { buildSetupFor } from './stellar/setup.js';
import { run } from './watcher/run.js';

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

  // Each dependency is the general function with this deployment's facts
  // already bound, so nothing downstream has to know where it is running.
  const verifyBurn = (txHash, recipient) =>
    verifyPaidBurn(rpc, txHash, { bridge, expectedRecipient: recipient });

  const attest = (txHash) =>
    fetchAttestation(isTestnet ? IRIS.testnet : IRIS.public, sourceDomain, txHash);

  // The funder signs here and nowhere earlier: the setup that goes out to the
  // browser is short exactly this signature, so it cannot be submitted for
  // three XLM by anyone who never burned.
  const funder = env.BRIDGE_FUNDER_SECRET
    ? Keypair.fromSecret(env.BRIDGE_FUNDER_SECRET)
    : null;
  const channel = env.BRIDGE_CHANNEL_SECRET
    ? Keypair.fromSecret(env.BRIDGE_CHANNEL_SECRET)
    : null;

  const submitSetup = (signedXdr, paidBurn) =>
    submit(chosen.horizon, signedXdr, {
      networkPassphrase: passphrase,
      paidBurn,
      funderSigner: funder,
    });

  const buildSetup =
    channel && funder
      ? (recipient, { amount } = {}) =>
          buildSetupFor(recipient, {
            horizon: chosen.horizon,
            asset: chosen.usdc,
            networkPassphrase: passphrase,
            channelSigner: channel,
            funderAddress: funder.publicKey(),
            startingXlm: CFG.activationXlm,
            timeoutSeconds: CFG.setupTimeoutSeconds,
            baseFee: CFG.baseFee,
            amount,
          })
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

  return {
    store,
    rpc,
    bridge,
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

  const server = listen(createHandler({ store: parts.store, verifyBurn: parts.verifyBurn, buildSetup: parts.buildSetup }), {
    port: parts.port,
    createServer,
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

  await run({ ...parts, signal: controller.signal, log });
}

// Only when run directly, so importing this for tests starts nothing.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: 'fatal', reason: String(error?.message ?? error) }));
    process.exit(1);
  });
}
