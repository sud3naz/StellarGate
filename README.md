# stellar-bridge

USDC from the EVM chains into Stellar, arriving in an account that already
works. Not a cheaper bridge — a front door.

Deployed on Base Sepolia and proven end to end, in forty seconds, into an
address that did not exist when the transfer started. Addresses and
transaction hashes are in [TESTNET.md](TESTNET.md). Nothing is deployed on
mainnet.

## The problem this exists for

Allbridge Core is the only real competitor on this route and it charges 0.3%,
which is cheaper than this. It also leaves the user at a wall: the USDC lands
on Stellar and they still have no funded account, no trustline and no XLM to
make either happen. Someone withdrawing from an exchange for the first time
gets across the bridge and can do nothing.

So the fee is 0.5% and it buys the far side: the trustline is there and the
user never had to hold XLM.

**Everyone pays 0.5%. Only somebody who cannot hold USDC without our help pays
more.** That costs five dollars and buys three XLM sent to the address
outright — one for the account reserve, half for the trustline, and 1.5 left
over as the user's own fee money.

The line is not "does an account exist". An address with no account cannot hold
USDC; neither can an account sitting on 1.2 XLM, which exists but is half an
XLM short of a trustline and has no way to close that gap on its own. Same
problem, same three XLM, same fee. The only difference is the operation:
`createAccount` for one, a `payment` for the other.

**We do not make anybody a wallet.** The user makes their own in Freighter and
holds their own key; nothing here generates or custodies one. A Stellar keypair
is free and made offline — what does not exist until someone pays for it is the
*account on the ledger*, and that is the only thing the five dollars buys.

Somebody withdrawing from an exchange has an account with XLM in it, pays their
own half-XLM reserve, and owes us nothing but a signature. That is most of
them, and it is the whole reason the fee is shaped this way.

That five dollars is adjustable, because its cost is three XLM and its price
is dollars, and those drift apart. Two things keep that honest:
`ACTIVATION_FEE_CEILING` is a constant at 20 USDC, so the fee genuinely cannot
be raised past it without a redeploy; and every caller passes the price they
were quoted, so a repricing cannot land on a transaction already in the
mempool. A cut goes through at the lower price; a rise reverts.

Sponsored reserves were the alternative and would have been cheaper for us,
since sponsorship locks capital rather than spending it. It was rejected for a
reason that only shows up later: a sponsored account holds **zero XLM**, and an
account with zero XLM cannot pay a transaction fee. It could receive USDC and
then be unable to send it anywhere without us signing for every move. Three XLM
buys independence, and independence is the product.

## How a transfer goes

```
Rabby + Freighter connected
        │
        ├─ read Horizon: does the account exist? is there a USDC trustline?
        │  └─ decides whether the five dollars applies at all
        │
        ├─ Freighter signs the setup                         ← signature first
        │  (held, not submitted)
        │
        ├─ Base: StellarBridge.bridge(amount, "G…", activate, fee)  ← the burn
        │
        ├─ submit the held setup while the attestation is pending
        │
        └─ Circle relays the hook → mint_and_forward → USDC in the account
```

The signature comes before the burn on purpose. If the user walks away at that
point nothing has happened; once they have burned, the transaction that makes
the far side work is already in hand, so there is no state where their money is
taken and cannot be delivered.

What the browser is handed to sign is deliberately incomplete. The setup has
to be built here — a page cannot know the channel account's sequence number,
and has no business knowing the funder's address — but a setup that leaves
this server already carrying the **funder's** signature is one the user can
simply submit themselves: three XLM, no burn, once per request. That is the
attack the ordering was meant to prevent, arriving by post instead. So the
channel signs, because it owns the sequence, and the funder signs on the far
side of the burn in `submit()`. What waits in the browser is real, theirs, and
short exactly the signature that makes `createAccount` work.

The user still signs something they did not build, though, and that is worth
one more thing. `web/envelope.js` decodes the setup before Freighter is asked
for anything, and refuses it unless every operation drawn on the user's own
account is a trustline for the USDC we named. A payment, a `setOptions` that
hands the account over, a trustline for somebody else's USDC — all refused
with an explanation, before a wallet is opened. It fails closed: an operation
type it does not recognise is a refusal, not a shrug.

The point is that the watcher and this page are not the same thing. One runs
on a server, the other is served from a CDN, and a watcher that has been
tampered with should not be able to ask a wallet for whatever it likes. If
this file is itself replaced then nothing here helps, and that threat belongs
to Freighter and to whoever reads what it shows them.

Funding only after a paid burn closes the obvious attack. The activation XLM is
**spent, not lent** — unrecoverable — so an endpoint that creates accounts on
request costs three XLM per browser tab to drain. `flow.js` gates it twice: on
a completed burn, and on that burn having carried the fee.

## Why the mint recipient is not the user

On the EVM chains `mintRecipient` is just the destination address. On Stellar
CCTP treats it as a **contract** address, so an ordinary `G…` account cannot be
named directly. Paying one goes through Circle's `CctpForwarder`: the burn
mints to the forwarder, and the forwarder pays the address carried in the hook
data. That is why the source side calls `depositForBurnWithHook` and why the
destination travels as UTF-8 text.

Hook layout, as Circle's forwarder parses it:

| bytes | |
|---|---|
| 0–23 | `cctp-forward`, the marker that makes Circle relay the forward for us |
| 24–27 | hook version, zero |
| 28–31 | length of the strkey |
| 32+ | the strkey, UTF-8 |

`forward_recipient` is parsed as a `MuxedAddress`, so `M…` works as well as
`G…`. That is the answer to exchange deposits: a payment out of a contract
cannot carry a classic memo, so the memo id is folded into the address instead.

## Two things that make this safe

**The address is checked on-chain, checksum included.** Stellar cannot tell a
typo from an address; the forwarder pays whatever parses. A wrong-but-valid
address is money gone. `StellarStrkey` decodes the base32 and verifies the
CRC16 before anything moves, and the fuzz test asserts that every possible
single-character typo is caught.

**A missing trustline is not fatal.** The forwarder finishes with a SAC
transfer, which reverts if the recipient has no USDC trustline — and the
message is not consumed, so `mint_and_forward` can simply be retried once the
trustline exists. Being late costs nothing.

## Stellar is domain 27, and it does take fast transfers

This document used to say the opposite, and the contract shipped believing it.
Stellar is widely taken to be standard-only. It is not.

A burn at `minFinalityThreshold` 1000 was attested in **twenty-nine seconds**
where hard finality took **twenty-five minutes**, and Stellar's
`TokenMessengerMinter` accepted the unfinalized message through
`handle_recv_unfinalized_message` — which the mainnet contract implements too,
and which Circle's fee API prices at 1.3 basis points on both networks. The
route sits unused, so it seems nobody had tried it.

Thirteen cents on a thousand dollars, against a wait no exchange withdrawal
survives. There is no version of this worth running at the slower speed, so
the choice is not offered: every burn goes out fast.

The wait that fast removes was doing work, though. The account setup used to
go in during a fifteen-minute attestation, described here as free. It now goes
in during a twenty-eight second one — measured at thirteen seconds for the
setup against twenty-eight for the attestation, so **fifteen seconds of
margin**. Submitting it promptly is not an optimisation any more.

### What Circle takes is an allowance, not a price

The fee is applied at the *destination*: Circle writes `feeExecuted` into the
burn message, bounded only by the `maxFee` sent from here. Nothing on the
source chain can be asked what it will be — `getMinFeeAmount` reverts on
Base's messenger, which predates the setting, and reading a zero from it is
what would break a fast transfer.

So `maxFee` is granted rather than read: `circleFeeAllowanceBps`, twenty basis
points, fifteen times what Circle has been observed to take. The asymmetry
sets the direction. A ceiling too low does not save anyone money — it stalls
transfers until an owner intervenes — while the cost of one too high is a
difference Circle has no reason to take, and would have to take visibly, from
every integrator at once. It is adjustable for the same reason the activation
fee is, and bounded by `MAX_CIRCLE_FEE_BPS` at 1%, which is not.

Setting it too low is recoverable, which was worth knowing rather than
assuming. A burn sent with `maxFee` of one unit sat for twenty minutes under
`delayReason: insufficient_fee`, then attested at hard finality instead —
`finalityThresholdExecuted` 2000 against the 1000 requested — and delivered in
full, with no fee at all. A wrong allowance costs speed, not money.

Circle's contracts, from their reference:

| | mainnet | testnet |
|---|---|---|
| TokenMessengerMinter | `CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL` | `CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP` |
| MessageTransmitter | `CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV` | `CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY` |
| CctpForwarder | `CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T` | `CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ` |

The constructor takes the forwarder as its raw 32-byte contract id, not the
strkey. Mainnet is
`0x72bd20ff2f8281801bb05b7c29179026933256fabafeb13e94efd8ddbcfcf291`, testnet
`0x3de86ac50b47eaf2840fe23e48179551660fd1072fba6f445d4a6bd7af4ab93e`.

## What is here

```
src/StellarBridge.sol         the Base-side collector: fee, validation, burn
src/StellarStrkey.sol         base32 + CRC16, so a typo cannot reach Stellar

api/src/flow.js               the ordering, as rules rather than as prose
api/src/stellar/account.js    what a destination is missing, and what it costs
api/src/stellar/activation.js buying an account, or just the trustline
api/src/stellar/setup.js      builds what the user signs, and signs half of it
api/src/watcher/index.js      the ordering, as one step that can be tested
api/src/watcher/burn.js       proof that a burn happened and paid for this
api/src/watcher/store.js      one burn buys one activation, across restarts
api/src/watcher/attestation.js  asking Circle, and reading a delay correctly
api/src/watcher/deliver.js    mint_and_forward, and what a refusal means
api/src/watcher/logs.js       following Bridged, behind the tip
api/src/watcher/run.js        the daemon, which holds no rules of its own
api/src/server.js             the one thing only the browser has: the signature
api/src/main.js               wiring, and the only file that reads the env
api/src/config.js             networks, issuers, Circle's contracts

web/index.html                the bridge, drawn as a bridge
web/app.js                    wallets, the destination check, the transfer
web/abi.js                    the two calls, encoded by hand and checked
web/envelope.js               reads a setup before Freighter is asked to sign it
web/strkey.js                 the browser copy of the address check

script/Deploy.s.sol           deployment, which guesses at nothing
```

```bash
forge test          # 47
cd api && npm test  # 153, the browser included
```

200 tests. `StellarStrkey` is checked against Circle's real USDC issuer address
on Stellar mainnet, because a checksum implementation that only agrees with
itself proves nothing. The hook layout is checked against the vectors in
Circle's own `cctp-forwarder` tests, and the burn parameters against the real
`TokenMessengerV2` source rather than against an interface written from the
docs.

## The two invariants, in code

`flow.js` exists because the ordering is the design, and prose does not survive
a retry loop. Both rules are enforced on the way in rather than documented:

- **Never burn before the signed setup is in hand.** Otherwise there is a state
  where the user's USDC is committed and the account it should land in cannot
  be created, because they closed the tab.
- **Never send XLM before a burn that paid for it.** The activation is spent,
  not lent. An endpoint that creates Stellar accounts on request costs three
  XLM per browser tab to attack.

The transaction source is a **channel account**, not the funder. The setup is
signed before the burn and submitted after it; a sequence number drawn from a
shared wallet would be invalidated by the next transfer in that window.

Both rules are enforced in `advance()`, and that turns out not to be enough.
Driving the flow by hand during the testnet run, the burn was submitted before
its `approve` had propagated and failed silently — and the setup went in
anyway, spending three XLM on an activation nobody had paid for. `advance()`
refuses exactly that transition. It was never called: `submit()` is reachable
without it.

So the guard has to sit where the money leaves, not beside it. Whoever spends
must **verify**, not be told: read the receipt from the source chain, find the
`Bridged` log, check the recipient it names and the `activate` flag it carries,
and take that as the proof — a value only obtainable by looking. A boolean can
be wrong about a burn. A receipt cannot. Two smaller things travel with it: the
burn must name *this* recipient, or one transfer funds another address; and a
transaction hash must be spendable once, or one payment opens accounts forever.

That is now `verifyPaidBurn` in `watcher/burn.js`, and `submit()` asks for its
result rather than for a flag. It also reads the transaction it is about to
send: an XDR carrying a `createAccount` or a native payment spends our XLM and
needs the proof, while a trustline on its own does not. The network passphrase
is a required argument for that reason — submitting without being able to see
what is being submitted is the hole itself. The address filter is the security
boundary in all this: `Bridged` is a signature anyone can emit, so a log from
any contract but ours is somebody else's event.

The gate is on **the XLM leaving**, not on whether an account exists. Creating
an account and topping up one that cannot afford its trustline both spend three
XLM, so both need the fee to have been paid. Adding a trustline to an account
that can cover its own reserve spends a transaction fee and nothing more, so it
is not gated behind a fee that user never owed.

`plan()` is where that decision is made, and it returns one of four shapes:
`none`, `trustline`, `topup`, `activation`.

## What is not here yet

- Concurrency. A channel account exists so that two transfers in flight
  cannot invalidate each other's sequence number, and every run so far has
  been one at a time — so the reason the channel exists is the one thing it
  has not been tested against. A pool of them is a config change; proving it
  needs two burns at once.
- Muxed `M…` destinations. The contract validates them and the forwarder
  parses them, which is the whole answer to exchange deposits, and no transfer
  has been sent to one.
- How long a fast attestation stays valid, and what a watcher should do as it
  approaches expiry.
- Coverage for the two shapes `plan()` returns that testnet never exercised:
  `trustline`, and the `topup` that carries the argument this whole thing
  rests on. Also the `op_no_trust` retry, muxed `M…` addresses, and anything
  concurrent — a channel account exists for concurrency, and one transfer at a
  time never tested it.

## Open decisions

- **Paying to activate an account that already exists.** Nothing stops a caller
  passing `activate: true` for a live address; they simply overpay. The
  frontend has to get this right, and the backend should probably refund rather
  than pocket it.
- **`MIN_AMOUNT` is 1 USDC**, rising to 6 when activating, so the fee cannot
  exceed the transfer.
- ~~**Freighter and unfunded accounts.**~~ Settled. Issue #1442 was folded into
  #1490 and fixed in 5.23.4: "the check for an unfunded account was incorrect
  and was the source of this error". Signing for an address that does not exist
  on the ledger works, which is what the whole no-account path rests on. Still
  worth one smoke test on a real extension, but it is no longer a design risk.
- ~~**Whether Circle actually relays the forward.**~~ Settled, and the answer
  is **no**. Two attested messages were left alone to find out: the standard
  one for fourteen minutes, the fast one for four. Neither was delivered.
  `mint_and_forward` is permissionless and costs **0.0075 XLM** — a quarter of
  a cent — so this is an item on the watcher's list rather than a problem.
  There is no user-facing button for it either: a choice the user can get
  wrong is not a feature, and the promise is that USDC arrives ready to spend.
- **How long a fast attestation stays valid.** Fast burn messages carry an
  `expirationBlock`; standard ones carry zero. Circle exposes
  `POST /v2/reattest/{nonce}`, which refreshes it while the burn still exists
  on the source chain, and past expiry the message reads as standard. What is
  not established is the window itself, or how that squares with a report of a
  Base→Arc transfer on mainnet that went undelivered for a week and was then
  recovered on the source side. Nothing found documents a return path to the
  source chain. Worth settling before the watcher's retry policy is written
  around it.

## Running the watcher

```bash
cd api
BRIDGE_CONTRACT=0x69752D7C3d1c7C919bc24e34cD440762F642FF00 \
BRIDGE_DELIVERY_SECRET=S… \
npm run watcher
```

`BRIDGE_DELIVERY_SECRET` is the account that pays for `mint_and_forward` —
about 0.0075 XLM a call, and it never holds user funds. Everything else has a
testnet default: source RPC, Soroban RPC, Circle's API, the store's path, and
the port. `BRIDGE_CURSOR` starts the log follower at a given block; without it
the watcher begins at the tip and does not go looking for history.

It writes one JSON line per event, so a collector can filter rather than parse
prose. The two loops run at different speeds on purpose: following logs is one
cheap call and being late by a few seconds only delays that user, while
sweeping the queue is what turns an attested transfer into USDC, and a fast
transfer attests in under thirty.
