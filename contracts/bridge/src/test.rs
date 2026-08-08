#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Events},
    token, Address, BytesN, Env,
};

use crate::{mint_recipient, Error, ReverseBridge, ReverseBridgeClient, MIN_AMOUNT};

/// A stand-in for Circle's messenger: it takes the USDC the way the real one
/// does, by transferring it out of the caller, and records what it was
/// asked for. Everything worth checking here is what we hand it.
mod messenger {
    use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env};

    #[contracttype]
    #[derive(Clone)]
    pub struct Call {
        pub amount: i128,
        pub destination_domain: u32,
        pub mint_recipient: BytesN<32>,
        pub destination_caller: BytesN<32>,
        pub max_fee: i128,
        pub min_finality_threshold: u32,
    }

    #[contracttype]
    pub enum Key {
        Last,
    }

    #[contract]
    pub struct Messenger;

    #[contractimpl]
    impl Messenger {
        #[allow(clippy::too_many_arguments)]
        pub fn deposit_for_burn(
            env: Env,
            caller: Address,
            amount: i128,
            destination_domain: u32,
            mint_recipient: BytesN<32>,
            burn_token: Address,
            destination_caller: BytesN<32>,
            max_fee: i128,
            min_finality_threshold: u32,
        ) {
            // The real one pulls with `transfer_from`, which is what makes an
            // allowance necessary rather than an authorised call. The first
            // version of this mock used `transfer`, every test passed, and the
            // contract failed on chain, so the mock's fidelity here is the
            // whole point of it.
            token::TokenClient::new(&env, &burn_token).transfer_from(
                &env.current_contract_address(),
                &caller,
                &env.current_contract_address(),
                &amount,
            );
            env.storage().instance().set(
                &Key::Last,
                &Call {
                    amount,
                    destination_domain,
                    mint_recipient,
                    destination_caller,
                    max_fee,
                    min_finality_threshold,
                },
            );
        }

        pub fn last(env: Env) -> Option<Call> {
            env.storage().instance().get(&Key::Last)
        }
    }
}

struct Fixture<'a> {
    env: Env,
    bridge: ReverseBridgeClient<'a>,
    messenger: messenger::MessengerClient<'a>,
    usdc: token::TokenClient<'a>,
    user: Address,
    treasury: Address,
    owner: Address,
}

fn setup() -> Fixture<'static> {
    let env = Env::default();
    env.mock_all_auths();

    let owner = Address::generate(&env);
    let treasury = Address::generate(&env);
    let user = Address::generate(&env);
    let issuer = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(issuer);
    let usdc = token::TokenClient::new(&env, &sac.address());
    token::StellarAssetClient::new(&env, &sac.address()).mint(&user, &1_000_000_000_000);

    let messenger_id = env.register(messenger::Messenger, ());
    let bridge_id = env.register(ReverseBridge, ());

    let bridge = ReverseBridgeClient::new(&env, &bridge_id);
    bridge.initialise(&owner, &treasury, &sac.address(), &messenger_id, &6);

    let messenger = messenger::MessengerClient::new(&env, &messenger_id);
    Fixture {
        env,
        bridge,
        messenger,
        usdc,
        user,
        treasury,
        owner,
    }
}

const ALICE: [u8; 20] = [
    0x23, 0x64, 0x07, 0xFd, 0xA3, 0x2b, 0x95, 0xCD, 0x54, 0x56, 0x74, 0x37, 0x53, 0xf2, 0x9B, 0x14,
    0x1E, 0xB2, 0x61, 0x1A,
];

fn alice(env: &Env) -> BytesN<20> {
    BytesN::from_array(env, &ALICE)
}

#[test]
fn takes_half_a_percent() {
    let f = setup();
    let amount = 1_000_000_000i128; // 100 USDC

    let (net, fee) = f.bridge.bridge(&f.user, &amount, &alice(&f.env));

    assert_eq!(fee, 5_000_000, "half a percent");
    assert_eq!(net + fee, amount, "nothing goes missing in the arithmetic");
    assert_eq!(f.bridge.accrued(), fee);
}

#[test]
fn burns_the_net_toward_the_far_side() {
    let f = setup();
    f.bridge.bridge(&f.user, &1_000_000_000, &alice(&f.env));

    let call = f.messenger.last().unwrap();
    assert_eq!(call.amount, 995_000_000, "the net, not the gross");
    assert_eq!(call.destination_domain, 6);
    assert_eq!(call.min_finality_threshold, 1000, "fast, as on the way in");
    assert_eq!(
        call.destination_caller,
        BytesN::from_array(&f.env, &[0u8; 32]),
        "anyone may claim it, so nobody can hold it hostage"
    );
}

/// The EVM lays an address out right-aligned in a word. Padding it the other
/// way produces a valid message that pays nobody, and CCTP has no way to tell.
#[test]
fn the_recipient_is_right_aligned() {
    let env = Env::default();
    let padded = mint_recipient(&env, &alice(&env)).to_array();

    assert_eq!(&padded[..12], &[0u8; 12], "twelve zero bytes first");
    assert_eq!(&padded[12..], &ALICE, "then the address");
}

#[test]
fn the_allowance_is_granted_not_asked_for() {
    let f = setup();
    f.bridge.bridge(&f.user, &1_000_000_000, &alice(&f.env));

    // Twenty basis points of the burn, fifteen times what Circle has been
    // seen to take.
    assert_eq!(f.messenger.last().unwrap().max_fee, 995_000_000 * 20 / 10_000);
}

#[test]
fn the_allowance_moves_but_not_past_its_ceiling() {
    let f = setup();

    f.bridge.set_circle_fee_bps(&40);
    f.bridge.bridge(&f.user, &1_000_000_000, &alice(&f.env));
    assert_eq!(f.messenger.last().unwrap().max_fee, 995_000_000 * 40 / 10_000);

    assert_eq!(
        f.bridge.try_set_circle_fee_bps(&101),
        Err(Ok(Error::AboveCeiling))
    );
}

/// The one mistake an EVM address makes unambiguously. Everything else about
/// twenty raw bytes is unverifiable, EIP-55 is a convention about
/// capitalisation, and it does not survive being lowercased on the way here.
#[test]
fn refuses_the_zero_address() {
    let f = setup();
    let zero = BytesN::from_array(&f.env, &[0u8; 20]);

    assert_eq!(
        f.bridge.try_bridge(&f.user, &1_000_000_000, &zero),
        Err(Ok(Error::RecipientIsZero))
    );
}

#[test]
fn refuses_dust() {
    let f = setup();
    assert_eq!(
        f.bridge.try_bridge(&f.user, &(MIN_AMOUNT - 1), &alice(&f.env)),
        Err(Ok(Error::AmountTooSmall))
    );
}

#[test]
fn nothing_moves_when_it_refuses() {
    let f = setup();
    let before = f.usdc.balance(&f.user);

    let _ = f.bridge.try_bridge(&f.user, &1, &alice(&f.env));

    assert_eq!(f.usdc.balance(&f.user), before, "the refusal came first");
}

#[test]
fn fees_go_to_the_treasury_and_only_once() {
    let f = setup();
    f.bridge.bridge(&f.user, &1_000_000_000, &alice(&f.env));

    let taken = f.bridge.withdraw_fees();
    assert_eq!(taken, 5_000_000);
    assert_eq!(f.usdc.balance(&f.treasury), 5_000_000);
    assert_eq!(f.bridge.accrued(), 0);

    assert_eq!(f.bridge.try_withdraw_fees(), Err(Ok(Error::NothingAccrued)));
}

#[test]
fn fees_accumulate_across_transfers() {
    let f = setup();
    f.bridge.bridge(&f.user, &1_000_000_000, &alice(&f.env));
    f.bridge.bridge(&f.user, &2_000_000_000, &alice(&f.env));

    assert_eq!(f.bridge.accrued(), 5_000_000 + 10_000_000);
}

#[test]
fn the_user_pays_exactly_the_gross() {
    let f = setup();
    let before = f.usdc.balance(&f.user);

    f.bridge.bridge(&f.user, &1_000_000_000, &alice(&f.env));

    assert_eq!(before - f.usdc.balance(&f.user), 1_000_000_000);
}

#[test]
fn a_second_initialise_is_refused() {
    let f = setup();
    let other = Address::generate(&f.env);

    assert_eq!(
        f.bridge
            .try_initialise(&other, &other, &other, &other, &6),
        Err(Ok(Error::AlreadyInitialised))
    );
}

#[test]
fn the_burn_is_announced() {
    let f = setup();
    f.bridge.bridge(&f.user, &1_000_000_000, &alice(&f.env));

    // The watcher has nothing else to follow: on this side there is no log to
    // read off a receipt, only what the contract chose to say.
    let ours = f.env.events().all().filter_by_contract(&f.bridge.address);
    assert!(!ours.events().is_empty(), "the watcher has to hear about it");
}

/// Only the owner may move the fees or the allowance, and `mock_all_auths` is
/// off so the check is the real one.
#[test]
fn strangers_cannot_take_the_fees() {
    let f = setup();
    f.bridge.bridge(&f.user, &1_000_000_000, &alice(&f.env));
    f.env.set_auths(&[]);

    assert!(f.bridge.try_withdraw_fees().is_err());
    assert!(f.bridge.try_set_circle_fee_bps(&30).is_err());
    let _ = f.owner; // named for the reader; the point is that nobody signed
}
