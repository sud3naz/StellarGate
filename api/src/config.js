import { Asset, Networks } from '@stellar/stellar-sdk';

/**
 * Both issuers were checked against Horizon rather than copied from a post:
 * the mainnet one answers with home_domain circle.com, the testnet one with
 * centre.io, and neither sets auth_required, so a trustline is usable the
 * moment it exists, with no authorisation step to wait on.
 */
export const USDC = {
  public: new Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'),
  testnet: new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'),
};

export const NETWORKS = {
  public: {
    horizon: 'https://horizon.stellar.org',
    passphrase: Networks.PUBLIC,
    usdc: USDC.public,
    // Circle's CctpForwarder. Every burn on the EVM side mints here, and this
    // contract pays the address carried in the hook data.
    forwarder: 'CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T',
  },
  testnet: {
    horizon: 'https://horizon-testnet.stellar.org',
    passphrase: Networks.TESTNET,
    usdc: USDC.testnet,
    forwarder: 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ',
  },
};

export const CFG = {
  network: process.env.BRIDGE_NETWORK || 'testnet',

  /// The account the activation XLM is paid out of. It never holds user funds.
  funder: process.env.BRIDGE_FUNDER || '',

  /**
   * What a new account is given. One XLM is its own reserve, half an XLM the
   * USDC trustline's, and the remaining 1.5 is the user's fee money, roughly
   * 150,000 operations at the 100-stroop base fee. Without that last part the
   * account could receive USDC and be unable to send it anywhere.
   *
   * The five dollars charged for this is fixed in USDC while the cost is fixed
   * in XLM, so the margin moves with the XLM price. At roughly $0.32 it is
   * about a dollar of cost against five of revenue; a five-fold rise in XLM
   * erases that.
   */
  activationXlm: process.env.BRIDGE_ACTIVATION_XLM || '3',

  /**
   * The setup transaction is signed early and submitted up to twenty minutes
   * later, while the attestation is pending. If it drew its sequence number
   * from the sponsor, any other transfer in that window would invalidate it.
   * So the sequence comes from a channel account instead, and there is one per
   * transfer in flight.
   */
  channels: (process.env.BRIDGE_CHANNELS || '').split(',').filter(Boolean),

  /**
   * How long a signed setup stays valid. Stellar has no Fast Transfer, so the
   * burn waits on Base hard finality, minutes, not seconds. This is that
   * window with room to spare; a transaction that expires is a user who signed
   * for nothing.
   */
  setupTimeoutSeconds: Number(process.env.BRIDGE_SETUP_TIMEOUT || 45 * 60),

  /// 100 stroops is the network base fee. Paying a multiple of it is how a
  /// transaction survives a busy ledger, and the sponsor pays it, not the user.
  baseFee: process.env.BRIDGE_BASE_FEE || '10000',
};

export function network(name = CFG.network) {
  const chosen = NETWORKS[name];
  if (!chosen) throw new Error(`unknown network: ${name}`);
  return chosen;
}
