# Testnet

Base Sepolia to Stellar testnet, 7 August 2026. Every address and hash below
is checkable. Nothing here touches mainnet.

## Deployed

| | |
|---|---|
| `StellarBridge` | [`0x69752D7C3d1c7C919bc24e34cD440762F642FF00`](https://sepolia.basescan.org/address/0x69752D7C3d1c7C919bc24e34cD440762F642FF00) |
| Owner, treasury | `0x236407FdA32b95CD5456743753f29B141EB2611A` |
| `FINALITY_FAST` | 1000 |
| `circleFeeAllowanceBps` | 20 |
| `activationFee` | 3 USDC |

A first deployment, [`0x81501bD46eEeD9E922c00bB41B63b842d909e991`](https://sepolia.basescan.org/address/0x81501bD46eEeD9E922c00bB41B63b842d909e991),
burned at hard finality. It is superseded and should not be used.

Circle's contracts this depends on, none of them ours:

| | |
|---|---|
| USDC (Base Sepolia) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| TokenMessengerV2 (domain 6) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| CctpForwarder (Stellar testnet) | `CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ` |
| USDC issuer (Stellar testnet) | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |

## The transfer that matters

An address with **no account on the ledger** — Horizon answered 404 — receiving
USDC and arriving able to spend it, having never held XLM.

| | |
|---|---|
| Burn on Base Sepolia | `0xaf406107764bab3b9e7d12142a1b67eefd9a24898f549ff404ff059cc9b00ec8` |
| Destination | `GAFKBZTURNATMAL6KBLKBOPBRF2WZ4DKPMO6MIAUFIXVQU5EH7CHOZ5Z` |
| Sent | 4.5 USDC |
| Arrived | **1.4773080 USDC and 3 XLM** |

Timed from the burn: the account existed with its trustline at **13 seconds**,
Circle attested at **28**, the USDC landed at **40**.

The same thing at hard finality, for comparison — same code, slower rail:

| | |
|---|---|
| Burn | `0xd7e372e0982827ad39085a51e5b32474b2cd86ec63e2571a822a7cec8ef8678b` |
| Destination | `GCTKVC77RXFLGZJQSSOIEMKVTNOJ7SFCP2QBZIJ225XY7VY5OXJSW5FV` |
| Arrived | 2.9600000 USDC and 3 XLM, after ~25 minutes |

## Everything else that was run

| Burn | What it tested | Result |
|---|---|---|
| `0x6e7eaa284bd36051b77ef5e16a6e4997390a6cec7695f529af08544118a73f84` | fast, through the contract, to an account already set up | 1.4923060 USDC, attested in 22s |
| `0xe9728a229b9bf696cfdc9fc2e1f754f8652de701485f3d139489380b7c8ee995` | hard finality, same shape | 1.9900000 USDC, attested in 25 min |
| `0xf968c66dbb91581a5749f00c77f9854ab92e818c0e1978c33f7c6c269ac6ec44` | fast, called on Circle's messenger directly | 1.9997400 USDC, attested in 29s |
| `0xceb356b4447601d23f596a9a00a03f0b89a3561d0842fe79bf29568eea4d681b` | `maxFee` deliberately too small | see below |

## Three things this settled

**Stellar takes fast transfers.** The claim that it does not is what this
repository was built on. Twenty-nine seconds against twenty-five minutes, for
1.3 basis points, with Stellar's `TokenMessengerMinter` accepting the
unfinalized message through `handle_recv_unfinalized_message` — a function the
mainnet contract implements as well. The route is unused, which is the likely
reason nobody had looked.

**Circle does not relay the forward.** Two messages were left attested and
untouched to find out: the standard one for fourteen minutes, the fast one for
four. Neither arrived. Every delivery here was made by calling
`mint_and_forward` directly, which anyone may do, at **0.0075 XLM** a call.

**A `maxFee` too small costs speed, not money.** The burn above went out with
an allowance of one unit, far under the 1.3 basis points Circle wanted. It sat
for twenty minutes reporting `delayReason: insufficient_fee`, then attested at
hard finality instead — `finalityThresholdExecuted` 2000 against the 1000
asked for — and delivered the full 2 USDC with no fee at all.

## One mistake, kept here on purpose

Driving this by hand, a burn was sent immediately after its `approve` and
failed because the allowance had not propagated. The setup transaction was
submitted anyway, and three XLM went out for an activation nobody had paid
for.

`flow.js` refuses that transition. It was never consulted: `submit()` is
reachable without going through `advance()`, so the guard sat beside the path
rather than on it. The fix is in the README — whoever spends the XLM has to
read the burn receipt itself rather than be told about it — and it is the
first thing the watcher has to get right.

Cost: three XLM of testnet money. Worth more than that as a finding.
