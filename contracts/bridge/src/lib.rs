#![no_std]

//! The other direction: USDC out of Stellar and into an EVM chain.
//!
//! The mirror of `StellarBridge.sol`, and deliberately a smaller thing. Going
//! the other way the destination needs nothing built for it, an EVM address
//! exists whether anybody has heard of it or not, there is no trustline to
//! add and no reserve to buy, so the elaborate part of this bridge has no
//! counterpart here. What is left is a fee, a check on the address, and the
//! burn.
//!
//! Which is worth saying plainly: **the user lands on the far side with USDC
//! and no gas.** That is the same wall this project exists to knock down,
//! wearing different clothes, and it is not knocked down here. Delivering the
//! USDC is all this does.
//!
//! One asymmetry drove the whole shape. On Stellar the mint recipient must be
//! a contract, which is why the forward direction goes through Circle's
//! forwarder and carries the address as text in hook data. Going this way the
//! recipient is an ordinary twenty-byte address, so `mint_recipient` is that
//! address left-padded into thirty-two bytes and there is no hook at all.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    Env, IntoVal, Symbol,
};

/// Half a percent, as on the source side, and fixed for the same reason: a
/// fee that can be raised quietly is not a fee anybody agreed to.
pub const FEE_BPS: i128 = 50;
pub const BPS_DENOM: i128 = 10_000;

/// Base's CCTP domain.
pub const DEFAULT_DESTINATION_DOMAIN: u32 = 6;

/// Soft finality, Circle's fast transfer. The forward direction found that
/// Stellar takes these despite the documentation reading otherwise; there was
/// never any doubt about the EVM chains.
pub const FINALITY_FAST: u32 = 1000;

/// What Circle may take on delivery, in basis points of the burn. An
/// allowance rather than a price, for the reason the Solidity side documents
/// at length: the fee is written into the message at the far end, bounded
/// only by what is sent from here.
pub const DEFAULT_CIRCLE_FEE_BPS: i128 = 20;
/// And a ceiling on that allowance which an owner cannot raise.
pub const MAX_CIRCLE_FEE_BPS: i128 = 100;

/// Dust floor, in USDC's seven decimals on Stellar. One dollar.
pub const MIN_AMOUNT: i128 = 10_000_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Kept for the number: `initialise` used to exist and could be called
    /// by anyone who got there first. Configuration now happens in the
    /// constructor, in the same transaction as the deploy, so there is no
    /// "first" to race for.
    AlreadyInitialised = 1,
    NotInitialised = 2,
    AmountTooSmall = 3,
    /// The twenty bytes were all zero. On an EVM chain that address is a hole
    /// money goes into and does not come out of, and unlike a mistyped
    /// Stellar address it has no checksum to catch it.
    RecipientIsZero = 4,
    AboveCeiling = 5,
    NothingAccrued = 6,
    /// New burns are stopped. Nothing already burned is affected.
    Paused = 7,
    /// The account accepting ownership is not the one it was offered to.
    NotProposedOwner = 8,
}

/// What the watcher follows. There is no receipt to read on this side, no
/// log a node will hand back for a transaction, so a burn is only knowable
/// through what the contract chose to say about it. `from` and `recipient`
/// are topics so it can be found without reading every event on the network.
#[contractevent(topics = ["bridged"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bridged {
    #[topic]
    pub from: Address,
    #[topic]
    pub recipient: BytesN<20>,
    pub gross: i128,
    pub net: i128,
    pub fee: i128,
}

#[contracttype]
#[derive(Clone)]
pub enum Key {
    Config,
    Accrued,
    Paused,
    /// Who has been offered ownership and has not yet taken it.
    ProposedOwner,
}

#[contracttype]
#[derive(Clone)]
pub struct Config {
    pub owner: Address,
    pub treasury: Address,
    /// The USDC contract on this network, the SAC, not the classic asset.
    pub usdc: Address,
    /// Circle's TokenMessengerMinter.
    pub messenger: Address,
    pub destination_domain: u32,
    pub circle_fee_bps: i128,
}

fn config(env: &Env) -> Result<Config, Error> {
    env.storage()
        .instance()
        .get(&Key::Config)
        .ok_or(Error::NotInitialised)
}

#[contract]
pub struct ReverseBridge;

#[contractimpl]
impl ReverseBridge {
    /// Configured at deploy, in the deploy.
    ///
    /// This used to be an `initialise` call made after the deploy, by
    /// whoever made it first, and "whoever" was the problem: the seconds
    /// between the two transactions were an open window in which anybody
    /// could name themselves owner and treasury of a contract that was
    /// about to be pointed at from a website. A constructor runs inside the
    /// deploy itself, so there is no window and no first.
    pub fn __constructor(
        env: Env,
        owner: Address,
        treasury: Address,
        usdc: Address,
        messenger: Address,
        destination_domain: u32,
    ) {
        env.storage().instance().set(
            &Key::Config,
            &Config {
                owner,
                treasury,
                usdc,
                messenger,
                destination_domain,
                circle_fee_bps: DEFAULT_CIRCLE_FEE_BPS,
            },
        );
        env.storage().instance().set(&Key::Accrued, &0i128);
        env.storage().instance().set(&Key::Paused, &false);
    }

    /// What a given amount would burn and cost. One subtraction the user can
    /// check, rather than two they have to trust.
    pub fn quote(amount: i128) -> (i128, i128) {
        let fee = amount * FEE_BPS / BPS_DENOM;
        (amount - fee, fee)
    }

    /// Takes the fee and burns the remainder toward the EVM side.
    ///
    /// `recipient` is the destination as its twenty raw bytes. There is no
    /// checksum to verify: EIP-55 is a convention about capitalisation, and
    /// an address that has been lowercased on the way here carries no
    /// evidence either way. The zero address is refused because it is the one
    /// mistake that is unambiguous.
    pub fn bridge(
        env: Env,
        from: Address,
        amount: i128,
        recipient: BytesN<20>,
    ) -> Result<(i128, i128), Error> {
        from.require_auth();

        if env.storage().instance().get(&Key::Paused).unwrap_or(false) {
            return Err(Error::Paused);
        }
        if amount < MIN_AMOUNT {
            return Err(Error::AmountTooSmall);
        }
        if recipient == BytesN::from_array(&env, &[0u8; 20]) {
            return Err(Error::RecipientIsZero);
        }

        let cfg = config(&env)?;
        let (net, fee) = Self::quote(amount);

        let usdc = token::TokenClient::new(&env, &cfg.usdc);
        usdc.transfer(&from, &env.current_contract_address(), &amount);

        let accrued: i128 = env.storage().instance().get(&Key::Accrued).unwrap_or(0);
        env.storage().instance().set(&Key::Accrued, &(accrued + fee));

        // Circle's messenger takes the tokens with `transfer_from`, not
        // `transfer`, the same approve-then-pull shape as the EVM side, so
        // what it needs is an allowance rather than permission to be called.
        // Authorising a `transfer` sub-invocation instead looks correct, runs
        // correctly against a mock that pulls the other way, and fails on
        // chain.
        //
        // The allowance is exactly the net and expires on the next ledger:
        // it is consumed inside this transaction, and an allowance that
        // outlives its purpose is a standing claim on this contract's balance.
        usdc.approve(
            &env.current_contract_address(),
            &cfg.messenger,
            &net,
            &(env.ledger().sequence() + 1),
        );

        let circle_allowance = net * cfg.circle_fee_bps / BPS_DENOM;

        env.invoke_contract::<()>(
            &cfg.messenger,
            &Symbol::new(&env, "deposit_for_burn"),
            (
                env.current_contract_address(),
                net,
                cfg.destination_domain,
                mint_recipient(&env, &recipient),
                cfg.usdc.clone(),
                // Zero: anyone may claim the mint on the far side, so nobody
                // can hold it hostage.
                BytesN::from_array(&env, &[0u8; 32]),
                circle_allowance,
                FINALITY_FAST,
            )
                .into_val(&env),
        );

        Bridged {
            from: from.clone(),
            recipient,
            gross: amount,
            net,
            fee,
        }
        .publish(&env);

        Ok((net, fee))
    }

    /// Moves collected fees to the treasury.
    pub fn withdraw_fees(env: Env) -> Result<i128, Error> {
        let cfg = config(&env)?;
        cfg.owner.require_auth();

        let accrued: i128 = env.storage().instance().get(&Key::Accrued).unwrap_or(0);
        if accrued == 0 {
            return Err(Error::NothingAccrued);
        }
        env.storage().instance().set(&Key::Accrued, &0i128);

        token::TokenClient::new(&env, &cfg.usdc).transfer(
            &env.current_contract_address(),
            &cfg.treasury,
            &accrued,
        );
        Ok(accrued)
    }

    /// Repoints what Circle is allowed to take. Bounded by
    /// {MAX_CIRCLE_FEE_BPS}, which is not repointable.
    pub fn set_circle_fee_bps(env: Env, bps: i128) -> Result<(), Error> {
        let mut cfg = config(&env)?;
        cfg.owner.require_auth();
        if bps > MAX_CIRCLE_FEE_BPS {
            return Err(Error::AboveCeiling);
        }
        cfg.circle_fee_bps = bps;
        env.storage().instance().set(&Key::Config, &cfg);
        Ok(())
    }

    /// Stops new burns; nothing already burned is touched. The far side is
    /// a watcher with an EVM key, and it can be down or wrong, and while it
    /// is being fixed the honest thing is to stop taking money into it.
    pub fn pause(env: Env) -> Result<(), Error> {
        config(&env)?.owner.require_auth();
        env.storage().instance().set(&Key::Paused, &true);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), Error> {
        config(&env)?.owner.require_auth();
        env.storage().instance().set(&Key::Paused, &false);
        Ok(())
    }

    pub fn paused(env: Env) -> bool {
        env.storage().instance().get(&Key::Paused).unwrap_or(false)
    }

    pub fn set_treasury(env: Env, treasury: Address) -> Result<(), Error> {
        let mut cfg = config(&env)?;
        cfg.owner.require_auth();
        cfg.treasury = treasury;
        env.storage().instance().set(&Key::Config, &cfg);
        Ok(())
    }

    /// Ownership moves in two steps, offer and accept, so a typo in the
    /// offer leaves the contract with its old owner rather than with nobody.
    pub fn propose_owner(env: Env, proposed: Address) -> Result<(), Error> {
        config(&env)?.owner.require_auth();
        env.storage().instance().set(&Key::ProposedOwner, &proposed);
        Ok(())
    }

    pub fn accept_ownership(env: Env, who: Address) -> Result<(), Error> {
        who.require_auth();
        let proposed: Option<Address> = env.storage().instance().get(&Key::ProposedOwner);
        if proposed.as_ref() != Some(&who) {
            return Err(Error::NotProposedOwner);
        }
        let mut cfg = config(&env)?;
        cfg.owner = who;
        env.storage().instance().set(&Key::Config, &cfg);
        env.storage().instance().remove(&Key::ProposedOwner);
        Ok(())
    }

    pub fn accrued(env: Env) -> i128 {
        env.storage().instance().get(&Key::Accrued).unwrap_or(0)
    }

    pub fn config(env: Env) -> Result<Config, Error> {
        config(&env)
    }
}

/// An EVM address as CCTP wants it: twenty bytes right-aligned in thirty-two,
/// which is how the EVM lays out an `address` in a word. Padding it the other
/// way round produces a perfectly valid message that pays nobody.
pub fn mint_recipient(env: &Env, recipient: &BytesN<20>) -> BytesN<32> {
    let mut padded = [0u8; 32];
    padded[12..].copy_from_slice(&recipient.to_array());
    BytesN::from_array(env, &padded)
}

#[cfg(test)]
mod test;
