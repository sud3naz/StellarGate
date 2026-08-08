# Testnet

Base Sepolia and Stellar testnet, both directions, 7 August 2026. Every address
and hash below is checkable. Nothing here touches mainnet.

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

An address with **no account on the ledger**, Horizon answered 404, receiving
USDC and arriving able to spend it, having never held XLM.

| | |
|---|---|
| Burn on Base Sepolia | `0xaf406107764bab3b9e7d12142a1b67eefd9a24898f549ff404ff059cc9b00ec8` |
| Destination | `GAFKBZTURNATMAL6KBLKBOPBRF2WZ4DKPMO6MIAUFIXVQU5EH7CHOZ5Z` |
| Sent | 4.5 USDC |
| Arrived | **1.4773080 USDC and 3 XLM** |

Timed from the burn: the account existed with its trustline at **13 seconds**,
Circle attested at **28**, the USDC landed at **40**.

The same thing at hard finality, for comparison, same code, slower rail:

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

## All four shapes, on chain

`plan()` decides what a destination needs and returns one of four answers. Two
of them were exercised in the first session; the other two are the ones the
fee argument actually rests on, so they were run properly rather than left as
assertions.

| plan | destination | burn | arrived | our XLM |
|---|---|---|---|---|
| `activation` | no account at all | `0xaf406107764bab3b9e7d12142a1b67eefd9a24898f549ff404ff059cc9b00ec8` | 1.4773080 USDC + 3 XLM | 3 XLM |
| `topup` | exists, holds 1.2 XLM | `0x0e528120dfcc83cbbc9f1cd205b16387ed8b1301cc6fd04fe9176543fa4cb471` | 1.4773080 USDC, XLM 1.2 → 4.2 | 3 XLM |
| `trustline` | exists, can pay its own way | `0xd3a5d84b6e2c5bbedd878067b2083a65e3c5dd998eb40f1c94faf0d135f613f1` | 1.4923060 USDC, XLM unchanged | none |
| `none` | already able to receive | `0x6e7eaa284bd36051b77ef5e16a6e4997390a6cec7695f529af08544118a73f84` | 1.4923060 USDC | none |

The `topup` row is the one the README argues for at length: an account that
exists but cannot afford its own trustline reserve is in the same position as
one that does not exist, so it gets the same three XLM and pays the same fee.
The only difference is the operation, a `payment` where the other gets a
`createAccount`. Seventeen seconds from burn to delivery.

The `trustline` row is the other half of that argument. That user's XLM
balance is untouched: they paid their own half-XLM reserve, we paid a
transaction fee, and they were charged no activation because they never owed
one.

## Being late costs nothing, checked rather than claimed

The delivery ends in a token transfer that fails if the recipient has no USDC
trustline. The claim has always been that this is survivable, the CCTP
message is not consumed, so the same one can be presented again. Run against
`0x2aa6bbc94909baf6e60e2b154c6d2174276da533c5b3c75db8f374d9d6ce1390`:

| | |
|---|---|
| First attempt, no trustline | refused at simulation, `retryable`, naming the trustline |
| Trustline added | (no output) |
| Same message, second attempt | delivered 1.1938450 USDC |

Nothing was lost and nothing had to be re-burned.

## Three things this settled

**Stellar takes fast transfers.** The claim that it does not is what this
repository was built on. Twenty-nine seconds against twenty-five minutes, for
1.3 basis points, with Stellar's `TokenMessengerMinter` accepting the
unfinalized message through `handle_recv_unfinalized_message`, a function the
mainnet contract implements as well. The route is unused, which is the likely
reason nobody had looked.

**Circle does not relay the forward.** Two messages were left attested and
untouched to find out: the standard one for fourteen minutes, the fast one for
four. Neither arrived. Every delivery here was made by calling
`mint_and_forward` directly, which anyone may do, at **0.0075 XLM** a call.

**A `maxFee` too small costs speed, not money.** The burn above went out with
an allowance of one unit, far under the 1.3 basis points Circle wanted. It sat
for twenty minutes reporting `delayReason: insufficient_fee`, then attested at
hard finality instead, `finalityThresholdExecuted` 2000 against the 1000
asked for, and delivered the full 2 USDC with no fee at all.

## One mistake, kept here on purpose

Driving this by hand, a burn was sent immediately after its `approve` and
failed because the allowance had not propagated. The setup transaction was
submitted anyway, and three XLM went out for an activation nobody had paid
for.

`flow.js` refuses that transition. It was never consulted: `submit()` is
reachable without going through `advance()`, so the guard sat beside the path
rather than on it. The fix is in the README, whoever spends the XLM has to
read the burn receipt itself rather than be told about it, and it is the
first thing the watcher has to get right.

Cost: three XLM of testnet money. Worth more than that as a finding.

## The other direction

Stellar to Base, proven the same way. `ReverseBridge` is a Soroban contract
and a much smaller thing than its Solidity counterpart, because going this way
there is nothing to build on the far side: an EVM address exists whether
anyone has heard of it or not.

| | |
|---|---|
| `ReverseBridge` | [`CCWMXUFXXYL6HEL4BYXRPLUXPGI2DEYEOP7TZX7EXWZBOM7WAWWDMWHR`](https://stellar.expert/explorer/testnet/contract/CCWMXUFXXYL6HEL4BYXRPLUXPGI2DEYEOP7TZX7EXWZBOM7WAWWDMWHR) |
| USDC (SAC, testnet) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| TokenMessengerMinter | `CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP` |

A first deployment, `CCYDQQ3R47IT2U4RO5ZRJKETUFYOR6IYMC5TEQLCTSMVHCNHZ7R77JTL`,
never completed a transfer. It is superseded, and why is below.

| | |
|---|---|
| Burn on Stellar | `cf745fd80751449d3f81fa91930dfb2f6f828e504d4d6dd06c7321c576dc8737` |
| Claim on Base | `0x61d4521167c5542ea5b28a0b26242945d14874be97ba5afee47dbc2d5daa097f` |
| Sent | 2 USDC |
| Arrived | 1.99 USDC, about a minute later |

Circle attested at hard finality despite being asked for soft, and it made no
difference: Stellar's own finality is seconds. The twenty-five minutes going
the other way were Base's, waiting on an L2 to settle against L1. This
direction has no such wait to buy off, which is the second thing the fast tier
turns out not to be needed for.

### The bug the tests could not see

The first deployment failed on chain with `Error(Contract, #9)`, out of a
`transfer_from` nobody had written. Circle's messenger takes the tokens by
pulling them, approve first, then `transfer_from`, the same shape as the EVM
side, and the contract had instead authorised a `transfer` sub-invocation,
which is the other way tokens move and not the one being used.

The mock in the tests pulled the same wrong way. So all fourteen passed, and
proved only that the contract agreed with a fiction. What settled it was
running against the real messenger, which is the whole argument for doing so:
a test double is a claim about somebody else's code, and claims want checking.
The mock now uses `transfer_from`, and would fail if the contract went back to
authorising a call.
