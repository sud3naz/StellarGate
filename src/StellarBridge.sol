// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {StellarStrkey} from "./StellarStrkey.sol";

/// @notice The part of Circle's CCTP v2 TokenMessenger this contract calls.
interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}

/**
 * @title StellarBridge
 * @notice Source side of the EVM to Stellar rail: takes the service fee and
 * burns the remainder toward Stellar, where it mints into the user's own
 * account.
 *
 * Stellar is CCTP domain 27 and, unlike the EVM chains, it will not take a
 * plain account as the mint recipient: CCTP treats `mintRecipient` as a
 * contract address there. Paying an ordinary `G…` account therefore goes
 * through Circle's own CctpForwarder, the burn mints to the forwarder, and
 * the forwarder pays the address carried in the hook data. So the recipient
 * travels as text, not as a 32-byte word, and this contract has to use
 * `depositForBurnWithHook` rather than the plain call.
 *
 * Two consequences worth stating, because both are load-bearing:
 *
 * 1. The address is checked here, in full, checksum included. A typo that
 *    still decodes is money gone forever, and Stellar cannot catch it for us.
 *    See {StellarStrkey}.
 *
 * 2. The user's Stellar account must exist and hold a USDC trustline before
 *    the mint, or the forwarder's final transfer reverts. That setup is the
 *    backend's job, sponsored so the user never needs XLM, and it is driven by
 *    the {Bridged} event below. A revert there is recoverable: the message is
 *    not consumed, so `mint_and_forward` can simply be retried once the
 *    trustline is in place. Nothing is lost by being late.
 *
 * Every burn goes out at soft finality. Stellar is widely taken not to support
 * Fast Transfer, this contract shipped believing it, and the chain says
 * otherwise: the same transfer attests in twenty-nine seconds rather than
 * twenty-five minutes, for 1.3 basis points. There is no version of this rail
 * worth running at the slower speed, so the choice is not offered. What Circle
 * may take for it is an allowance rather than a price, because the fee is
 * applied at the far end and nothing here can ask for it. See
 * {circleFeeAllowanceBps}.
 *
 * The fee remains avoidable by calling CCTP directly. This charges for the
 * interface and for the account setup on the far side, not for access to the
 * rail.
 */
contract StellarBridge is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Service fee, fixed at compile time so it cannot be quietly
    /// raised. Half a percent, and it is what everyone pays: a flat fee on
    /// every transfer is what makes a small one absurd, and small transfers
    /// are the ones this bridge exists to win.
    uint256 public constant FEE_BPS = 50;
    uint256 public constant BPS_DENOM = 10_000;

    /**
     * @notice Hard cap on the activation fee. A constant, so this one really
     * cannot be raised without a redeploy.
     *
     * The fee below it moves because its cost is denominated in XLM while the
     * fee is denominated in USDC, and those drift apart. This bounds that
     * drift at four times the starting price. Past it the answer is to send
     * less XLM, three is generous, and about 1.6 is the functional minimum, * not to charge more.
     */
    uint256 public constant ACTIVATION_FEE_CEILING = 20e6; // 20 USDC

    /// @notice Floor on a transfer, purely to keep dust out.
    uint256 public constant MIN_AMOUNT = 1e6; // 1 USDC, six decimals

    /// @notice Stellar's CCTP domain.
    uint32 public constant STELLAR_DOMAIN = 27;
    /**
     * @notice Soft finality, which is to say Fast Transfer.
     *
     * Stellar does support it. Circle's documentation is read as saying
     * otherwise and the route sits unused, so this went untested, but the
     * chain disagrees with the reading. Burning at this threshold on Base
     * Sepolia was attested in **29 seconds** against **25 minutes** for hard
     * finality, and Stellar's TokenMessengerMinter took the unfinalized
     * message through `handle_recv_unfinalized_message`, which mainnet also
     * implements. The cost is 1.3 basis points where hard finality is free:
     * thirteen cents on a thousand dollars, against a wait no exchange
     * withdrawal survives.
     */
    uint32 public constant FINALITY_FAST = 1000;

    /// @notice Ceiling on what Circle may be authorised to take, 1% of the
    /// burn. {circleFeeAllowanceBps} moves below this; this does not move.
    uint256 public constant MAX_CIRCLE_FEE_BPS = 100;

    /// @dev Circle's marker telling their own relayer that this hook is a
    /// forward it should execute. Without it the mint still works, but
    /// somebody has to call `mint_and_forward` themselves.
    bytes24 private constant HOOK_MAGIC = bytes24("cctp-forward");
    /// @dev Hook data version the Stellar forwarder expects.
    uint32 private constant HOOK_VERSION = 0;

    error ZeroAddress();
    error AmountTooSmall(uint256 amount, uint256 minimum);
    error ExceedsAccruedFees(uint256 requested, uint256 available);
    error CircleFeeTooHigh(uint256 required, uint256 ceiling);
    error AboveCeiling(uint256 requested, uint256 ceiling);
    error ActivationFeeChanged(uint256 current, uint256 accepted);

    /// @dev `activate` is what the Stellar side acts on: the three XLM go out
    /// only for a transfer that paid for them, so the funding endpoint cannot
    /// be drained by anyone who has not.
    event Bridged(
        address indexed user,
        string stellarRecipient,
        uint256 gross,
        uint256 net,
        uint256 fee,
        uint8 recipientVersion,
        bool activate
    );
    event FeesWithdrawn(address indexed to, uint256 amount);
    event TreasuryUpdated(address indexed treasury);
    event ActivationFeeUpdated(uint256 previous, uint256 current);
    event CircleFeeAllowanceUpdated(uint256 previous, uint256 current);

    IERC20 public immutable usdc;
    ITokenMessengerV2 public immutable messenger;
    /// @notice Circle's CctpForwarder on Stellar, as its raw 32-byte contract
    /// id. Every burn from here mints to it, and it pays the user.
    bytes32 public immutable forwarder;
    address public treasury;

    /**
     * @notice What activating an address costs, when it needs it.
     *
     * Charged only when the destination has no Stellar account, and it buys
     * one outright: three XLM sent to the address, not lent to it.
     *
     * Worth being precise about what this does and does not do. The user makes
     * their own wallet, in Freighter, and holds their own key; nothing here
     * generates or custodies one. On Stellar a keypair costs nothing and is
     * created offline, but the address does not exist on the ledger until
     * somebody funds it, and that is the only thing being bought. Sponsored
     * reserves were the alternative and would have cost less, since
     * sponsorship locks capital rather than spending it, but a sponsored
     * account holds zero XLM, and an account with zero XLM cannot pay a
     * transaction fee. It could receive USDC and then be unable to send it
     * anywhere without us signing for every move.
     *
     * Everybody else pays nothing for this. Somebody withdrawing from an
     * exchange already has an account, and charging them for one is how you
     * lose them.
     *
     * Adjustable because the cost is three XLM and the fee is dollars, and
     * those drift. Bounded by {ACTIVATION_FEE_CEILING}, and every caller
     * states the price they accepted, so it cannot be moved out from under a
     * transaction already in the mempool.
     */
    uint256 public activationFee = 5e6; // 5 USDC

    /**
     * @notice What Circle is authorised to take out of a burn, in basis
     * points of the amount sent.
     *
     * Not a price we are quoted, an allowance we grant. On a fast transfer
     * the fee is applied at the *destination*, written into the message as
     * `feeExecuted` and bounded only by the `maxFee` sent from here. Circle
     * fills that number in, so whatever is set here is what they may take.
     * Observed behaviour is that they take exactly their published minimum
     * (1.3 bps, to the unit), and taking more would be visible on-chain to
     * every integrator at once, but it is an allowance, and worth reading as
     * one.
     *
     * Twenty basis points is fifteen times the current fee. The asymmetry is
     * the reason for the headroom: setting it too low does not save anyone
     * money, it fails transfers until an owner intervenes, whereas the cost of
     * setting it high is a difference Circle has no reason to take. Adjustable
     * for the same reason {activationFee} is, Circle's number can move and a
     * redeploy is a poor way to find out, and bounded by
     * {MAX_CIRCLE_FEE_BPS}, which cannot move at all.
     */
    uint256 public circleFeeAllowanceBps = 20;

    uint256 public accruedFees;
    uint256 public totalFeesCollected;
    uint256 public totalBridged;

    constructor(address initialOwner, address usdc_, address messenger_, bytes32 forwarder_, address treasury_)
        Ownable(initialOwner)
    {
        if (usdc_ == address(0) || messenger_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (forwarder_ == bytes32(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        messenger = ITokenMessengerV2(messenger_);
        forwarder = forwarder_;
        treasury = treasury_;
    }

    /**
     * @notice Takes the service fee and burns the remainder toward Stellar.
     * @param amount Gross USDC pulled from the caller; approve it first.
     * @param stellarRecipient The destination as a strkey: a `G…` account, or
     *        an `M…` muxed address when the far end needs a memo id, which is
     *        how an exchange deposit has to be addressed from a contract.
     * @param activate Whether to buy the destination a Stellar account. Set it
     *        for an address that does not exist on the ledger yet; the caller
     *        pays {activationFee} and the Stellar side sends the XLM. Setting
     *        it for an account that already exists only overpays, and setting
     *        it falsely for one that does not means the transfer arrives with
     *        nowhere to land, recoverable, since the delivery can be retried
     *        once the account exists, but the user has to sort that out.
     * @param acceptedActivationFee The activation price the caller agreed to,
     *        as quoted. Ignored when `activate` is false. This is what stops a
     *        fee change landing on a transaction that is already in flight:
     *        the quote the user saw is the quote they pay, or nothing happens.
     * @return net Amount burned toward Stellar.
     * @return fee Service fee retained here.
     */
    function bridge(
        uint256 amount,
        string calldata stellarRecipient,
        bool activate,
        uint256 acceptedActivationFee
    ) external nonReentrant returns (uint256 net, uint256 fee) {
        uint256 activation = activate ? activationFee : 0;
        if (activate && activation > acceptedActivationFee) {
            revert ActivationFeeChanged(activation, acceptedActivationFee);
        }

        uint256 floor = MIN_AMOUNT + activation;
        if (amount < floor) revert AmountTooSmall(amount, floor);

        // Reverts on a bad address, before any money moves.
        uint8 recipientVersion = StellarStrkey.validate(stellarRecipient);

        (net, fee) = quote(amount, activate);

        // What Circle may take, not what they have asked for. On a fast
        // transfer the fee lands at the destination, and the source accepts
        // any ceiling at all, including one too small to cover it. So this is
        // granted rather than read, and {circleFeeAllowanceBps} is set with
        // enough headroom that Circle never runs into it.
        uint256 circleFee = circleFeeAllowance(net);

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Effects before the external call.
        accruedFees += fee;
        totalFeesCollected += fee;
        totalBridged += amount;

        usdc.forceApprove(address(messenger), net);
        messenger.depositForBurnWithHook(
            net,
            STELLAR_DOMAIN,
            // Not the user: on Stellar the mint recipient must be a contract,
            // so it is Circle's forwarder, which then pays the hook address.
            forwarder,
            address(usdc),
            // Zero: anyone may trigger the mint, so nobody can hold it hostage.
            bytes32(0),
            circleFee,
            FINALITY_FAST,
            _hookData(stellarRecipient)
        );
        usdc.forceApprove(address(messenger), 0);

        emit Bridged(msg.sender, stellarRecipient, amount, net, fee, recipientVersion, activate);
    }

    /**
     * @notice Moves collected fees to the treasury.
     * @dev Bounded by `accruedFees`. In normal operation that is the whole
     * balance anyway, since user funds burn in the transaction they arrive in.
     */
    function withdrawFees(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0 || amount > accruedFees) revert ExceedsAccruedFees(amount, accruedFees);
        accruedFees -= amount;
        usdc.safeTransfer(treasury, amount);
        emit FeesWithdrawn(treasury, amount);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /**
     * @notice Repoints the activation fee at what three XLM currently costs.
     * @dev Bounded by {ACTIVATION_FEE_CEILING} and announced, so the change is
     * visible on-chain before anyone pays it. Zero is allowed: giving accounts
     * away is a decision, not a bug.
     */
    function setActivationFee(uint256 fee) external onlyOwner {
        if (fee > ACTIVATION_FEE_CEILING) revert AboveCeiling(fee, ACTIVATION_FEE_CEILING);
        emit ActivationFeeUpdated(activationFee, fee);
        activationFee = fee;
    }

    /**
     * @notice What a given amount would burn and cost, for the quote box and
     * for {bridge} itself.
     * @dev The percentage is taken on the whole amount, activation included,
     * so that the quote is one subtraction the user can check rather than two
     * they have to trust.
     */
    function quote(uint256 amount, bool activate) public view returns (uint256 net, uint256 fee) {
        fee = (amount * FEE_BPS) / BPS_DENOM;
        if (activate) fee += activationFee;
        net = amount - fee; // remainder to the user; rounding never favours us
    }

    /**
     * @notice The ceiling authorised to Circle for a burn of `net`.
     *
     * @dev Not what they will take, what they may. The fee is applied at the
     * destination and only becomes a number when Circle writes `feeExecuted`
     * into the message, so nothing on this chain can be asked. Observed: 1.3
     * basis points, which is their published minimum, against the twenty this
     * authorises.
     */
    function circleFeeAllowance(uint256 net) public view returns (uint256) {
        return (net * circleFeeAllowanceBps) / BPS_DENOM;
    }

    /**
     * @notice Repoints what Circle is allowed to take.
     * @dev Adjustable because Circle's fee can move and a stuck rail is a poor
     * way to learn that. Bounded by {MAX_CIRCLE_FEE_BPS}, which cannot move.
     *
     * Lowering this is the dangerous direction. A ceiling too small does not
     * fail at the burn, the source accepts any `maxFee`, including one that
     * cannot cover the fee, so the money is already committed by the time it
     * matters.
     */
    function setCircleFeeAllowance(uint256 bps) external onlyOwner {
        if (bps > MAX_CIRCLE_FEE_BPS) revert AboveCeiling(bps, MAX_CIRCLE_FEE_BPS);
        emit CircleFeeAllowanceUpdated(circleFeeAllowanceBps, bps);
        circleFeeAllowanceBps = bps;
    }

    /// @notice The hook data a given recipient produces, exposed so the
    /// frontend and the tests can check it against the Stellar side without
    /// having to rebuild the layout by hand.
    function hookDataFor(string calldata stellarRecipient) external pure returns (bytes memory) {
        StellarStrkey.validate(stellarRecipient);
        return _hookData(stellarRecipient);
    }

    /**
     * @dev The layout Circle's forwarder parses:
     *
     *     bytes  0-23  magic, or zero to opt out of Circle relaying the forward
     *     bytes 24-27  hook version, zero
     *     bytes 28-31  length of the strkey that follows
     *     bytes 32+    the strkey, UTF-8
     */
    function _hookData(string calldata stellarRecipient) private pure returns (bytes memory) {
        return abi.encodePacked(HOOK_MAGIC, HOOK_VERSION, uint32(bytes(stellarRecipient).length), stellarRecipient);
    }

    /**
     * @notice Disabled. Renouncing would leave accrued fees permanently
     * unwithdrawable; transfer to a multisig instead.
     */
    function renounceOwnership() public view override onlyOwner {
        revert ZeroAddress();
    }
}
