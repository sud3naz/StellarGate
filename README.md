# stellar-bridge

USDC from the EVM chains into Stellar, arriving in an account that already
works. Not a cheaper bridge — a front door.

Nothing here is deployed.

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

## Stellar is domain 27, and standard only

Stellar is on CCTP **V2** with domain **27**, and it does **not** support Fast
Transfer. So the speed is fixed at hard finality: there is no fast tier to
sell. The attestation window is minutes, not seconds, which is also the window
the setup is submitted in.

What is *not* fixed is Circle's own fee. `minFee` is a setting on the
messenger and `_depositForBurn` requires `maxFee` to clear it on **every**
burn, standard included — it is not a fast-transfer thing. Base's deployed
messenger predates the setting (`minFee()` and `getMinFeeAmount()` both revert
there today, checked on-chain), so zero is correct right now. But that
messenger is a proxy. So the fee is read at call time through a probe that
treats a missing function as zero, and bounded at 1% of the burn: if Circle
ever asks for more, the transfer reverts instead of quietly shrinking.

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
api/src/config.js             networks, issuers, Circle's contracts

web/index.html                the bridge, drawn as a bridge
web/app.js                    wallets, the live destination check, the quote
web/strkey.js                 the browser copy of the address check
```

```bash
forge test          # 44
cd api && npm test  # 49, the browser included
```

93 tests. `StellarStrkey` is checked against Circle's real USDC issuer address
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
signed before the burn and submitted up to twenty minutes later; a sequence
number drawn from a shared wallet would be invalidated by the next transfer in
that window.

The gate is on **the XLM leaving**, not on whether an account exists. Creating
an account and topping up one that cannot afford its trustline both spend three
XLM, so both need the fee to have been paid. Adding a trustline to an account
that can cover its own reserve spends a transaction fee and nothing more, so it
is not gated behind a fee that user never owed.

`plan()` is where that decision is made, and it returns one of four shapes:
`none`, `trustline`, `topup`, `activation`.

## What is not here yet

- The watcher that ties Base's `Bridged` log to `submit-setup`, and the store
  behind it. The rules it has to obey are in `flow.js` and tested; the plumbing
  is not written.
- Deployment scripts. Deliberately — nothing gets deployed without being asked.

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
- **Whether Circle actually relays the forward.** The magic bytes are right —
  they match `CIRCLE_MAGIC` in Circle's own forwarder tests — but that only
  proves the forwarder *parses* them. That Circle's service then calls
  `mint_and_forward` on our behalf is read off a source comment ("set to 0 to
  opt out of forwarding by Circle"), not off anything observed. If it turns
  out they do not, we run the call ourselves: it is permissionless, so this is
  a cost, not a blocker. Worth settling on testnet before it shapes the ops
  plan.
