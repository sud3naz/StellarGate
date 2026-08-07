// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {StellarBridge, ITokenMessengerV2} from "../src/StellarBridge.sol";
import {StellarStrkey} from "../src/StellarStrkey.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Records what CCTP was asked to do, and burns the USDC so the balance
/// arithmetic in the tests matches the real thing.
contract MockTokenMessenger is ITokenMessengerV2 {
    struct Call {
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        bytes hookData;
    }

    Call public lastCall;
    uint256 public callCount;

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external {
        lastCall = Call(
            amount,
            destinationDomain,
            mintRecipient,
            burnToken,
            destinationCaller,
            maxFee,
            minFinalityThreshold,
            hookData
        );
        ++callCount;
        IERC20(burnToken).transferFrom(msg.sender, address(this), amount);
    }

    /// @dev Base's deployed messenger has no `minFee` at all, so by default
    /// this mock does not answer `getMinFeeAmount` either. Setting it non-zero
    /// simulates Circle upgrading the proxy and switching the fee on.
    uint256 public minFeeBps;
    bool public exposesMinFee;

    function setMinFee(uint256 bps) external {
        minFeeBps = bps;
        exposesMinFee = true;
    }

    function getMinFeeAmount(uint256 amount) external view returns (uint256) {
        if (!exposesMinFee) revert("no such function");
        return (amount * minFeeBps) / 10_000;
    }

    function recorded() external view returns (Call memory) {
        return lastCall;
    }

    function lastHookData() external view returns (bytes memory) {
        return lastCall.hookData;
    }
}

contract StellarBridgeTest is Test {
    MockUSDC internal usdc;
    MockTokenMessenger internal messenger;
    StellarBridge internal bridge;

    address internal owner = address(0xA11CE);
    address internal treasury = address(0x7EA);
    address internal user = address(0xB0B);

    /// @dev Circle's CctpForwarder on Stellar mainnet,
    /// CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T, as its raw
    /// contract id. Only its 32 bytes reach CCTP; the strkey is the label.
    bytes32 internal constant FORWARDER = 0x72bd20ff2f8281801bb05b7c29179026933256fabafeb13e94efd8ddbcfcf291;

    string internal constant RECIPIENT = "GAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB7JZX";
    string internal constant RECIPIENT_MUXED =
        "MAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB6AAAAAAAAAAE2KZ3Q";

    function setUp() public {
        usdc = new MockUSDC();
        messenger = new MockTokenMessenger();
        bridge = new StellarBridge(owner, address(usdc), address(messenger), FORWARDER, treasury);

        usdc.mint(user, 1_000_000e6);
        vm.prank(user);
        usdc.approve(address(bridge), type(uint256).max);
    }

    // --- the fee ---------------------------------------------------------

    function test_takesHalfAPercent() public {
        vm.prank(user);
        (uint256 net, uint256 fee) = bridge.bridge(1000e6, RECIPIENT, false, 0);

        assertEq(fee, 5e6, "fee is 0.5%");
        assertEq(net, 995e6, "the rest is burned");
        assertEq(bridge.accruedFees(), 5e6);
        assertEq(usdc.balanceOf(address(bridge)), 5e6, "only the fee stays behind");
    }

    /// @dev A hundred dollars costs fifty cents, which is the whole argument
    /// against a fixed activation fee.
    function test_smallTransferStaysCheap() public {
        vm.prank(user);
        (, uint256 fee) = bridge.bridge(100e6, RECIPIENT, false, 0);
        assertEq(fee, 0.5e6);
    }

    function testFuzz_roundingNeverFavoursUs(uint256 amount) public view {
        amount = bound(amount, bridge.MIN_AMOUNT(), 1_000_000e6);
        (uint256 net, uint256 fee) = bridge.quote(amount, false);
        assertEq(net + fee, amount, "nothing is created or lost");
        assertLe(fee * 10_000, amount * 50, "the fee never rounds up");
    }

    function test_rejectsDust() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(StellarBridge.AmountTooSmall.selector, uint256(1e6 - 1), uint256(1e6)));
        bridge.bridge(1e6 - 1, RECIPIENT, false, 0);
    }

    // --- activation, which only the accountless pay ----------------------

    /// @dev The whole argument for this shape: somebody withdrawing from an
    /// exchange already has an account, and they pay nothing for one.
    function test_existingAccountPaysNothingForActivation() public {
        vm.prank(user);
        (, uint256 fee) = bridge.bridge(100e6, RECIPIENT, false, 0);
        assertEq(fee, 0.5e6, "half a percent and not a cent more");
    }

    function test_activationAddsFiveDollarsAndNothingElse() public {
        vm.prank(user);
        (uint256 net, uint256 fee) = bridge.bridge(100e6, RECIPIENT, true, 5e6);

        assertEq(fee, 0.5e6 + 5e6, "the percentage plus the account");
        assertEq(net, 94.5e6);
    }

    /// @dev The three XLM are bought with this money, so it has to stay here
    /// rather than ride along to Stellar with the rest.
    function test_activationMoneyStaysToBuyTheXlm() public {
        vm.prank(user);
        bridge.bridge(100e6, RECIPIENT, true, 5e6);

        assertEq(usdc.balanceOf(address(bridge)), 5.5e6, "the percentage and the account");
        assertEq(bridge.accruedFees(), 5.5e6, "withdrawable, and it funds the sponsor wallet");
        assertEq(messenger.recorded().amount, 94.5e6, "only the rest is burned");
    }

    function test_quoteAgreesWithWhatIsCharged() public {
        (uint256 quotedNet, uint256 quotedFee) = bridge.quote(250e6, true);

        vm.prank(user);
        (uint256 net, uint256 fee) = bridge.bridge(250e6, RECIPIENT, true, 5e6);

        assertEq(net, quotedNet);
        assertEq(fee, quotedFee);
    }

    /// @dev Five dollars of fee out of a four dollar transfer is not a
    /// transfer, so the floor rises with the activation.
    function test_activationRaisesTheFloor() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(StellarBridge.AmountTooSmall.selector, uint256(4e6), uint256(6e6))
        );
        bridge.bridge(4e6, RECIPIENT, true, 5e6);

        // The same amount is fine without it.
        vm.prank(user);
        bridge.bridge(4e6, RECIPIENT, false, 0);
    }

    // --- the activation fee moves, within limits -------------------------

    event ActivationFeeUpdated(uint256 previous, uint256 current);

    /// @dev It has to move: the cost is three XLM and the fee is dollars.
    function test_ownerCanRepriceActivation() public {
        vm.expectEmit(false, false, false, true, address(bridge));
        emit ActivationFeeUpdated(5e6, 8e6);

        vm.prank(owner);
        bridge.setActivationFee(8e6);

        assertEq(bridge.activationFee(), 8e6);

        vm.prank(user);
        (, uint256 fee) = bridge.bridge(100e6, RECIPIENT, true, 8e6);
        assertEq(fee, 0.5e6 + 8e6);
    }

    /// @dev The part that stays honest: a hard cap that really does need a
    /// redeploy to move.
    function test_repricingStopsAtTheCeiling() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(StellarBridge.AboveCeiling.selector, uint256(20e6 + 1), uint256(20e6))
        );
        bridge.setActivationFee(20e6 + 1);

        vm.prank(owner);
        bridge.setActivationFee(20e6); // the ceiling itself is fine
        assertEq(bridge.activationFee(), 20e6);
    }

    function test_onlyOwnerReprices() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        bridge.setActivationFee(1e6);
    }

    /// @dev Giving accounts away is a decision, not a bug.
    function test_activationCanBeMadeFree() public {
        vm.prank(owner);
        bridge.setActivationFee(0);

        vm.prank(user);
        (, uint256 fee) = bridge.bridge(100e6, RECIPIENT, true, 0);
        assertEq(fee, 0.5e6, "the percentage only");
    }

    /**
     * @dev The reason the caller states a price. A user quoted five dollars
     * signs for five dollars; if the fee is raised while their transaction
     * sits in the mempool, it reverts rather than charging them the new one.
     */
    function test_repricingCannotLandOnATransactionInFlight() public {
        vm.prank(owner);
        bridge.setActivationFee(15e6);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(StellarBridge.ActivationFeeChanged.selector, uint256(15e6), uint256(5e6))
        );
        bridge.bridge(100e6, RECIPIENT, true, 5e6);
    }

    /// @dev A cut in the caller's favour is not a surprise, so it goes through
    /// at the lower price rather than failing on a stale quote.
    function test_aCutIsPassedOnRatherThanRejected() public {
        vm.prank(owner);
        bridge.setActivationFee(2e6);

        vm.prank(user);
        (, uint256 fee) = bridge.bridge(100e6, RECIPIENT, true, 5e6);
        assertEq(fee, 0.5e6 + 2e6, "charged the new price, not the quoted one");
    }

    /// @dev The guard is only about activation; an ordinary transfer never
    /// touches it.
    function test_theGuardIsIgnoredWithoutActivation() public {
        vm.prank(owner);
        bridge.setActivationFee(20e6);

        vm.prank(user);
        (, uint256 fee) = bridge.bridge(100e6, RECIPIENT, false, 0);
        assertEq(fee, 0.5e6);
    }

    // --- what CCTP is asked to do ---------------------------------------

    function test_burnsTowardStellarThroughTheForwarder() public {
        vm.prank(user);
        bridge.bridge(1000e6, RECIPIENT, false, 0);

        MockTokenMessenger.Call memory c = messenger.recorded();

        assertEq(c.amount, 995e6, "the net amount is burned");
        assertEq(c.destinationDomain, 27, "Stellar");
        assertEq(c.mintRecipient, FORWARDER, "mints to the forwarder, not the user");
        assertEq(c.burnToken, address(usdc));
        assertEq(c.destinationCaller, bytes32(0), "anyone may trigger the mint");
        assertEq(c.maxFee, 1.99e6, "what Circle may take on delivery, not what they asked for");
        assertEq(c.minFinalityThreshold, 1000, "soft finality: Stellar does take fast transfers");
    }

    /// @dev The layout Circle's forwarder parses. If this drifts, the mint
    /// lands in the forwarder and stops there.
    function test_hookDataLayout() public {
        vm.prank(user);
        bridge.bridge(1000e6, RECIPIENT, false, 0);

        bytes memory hookData = messenger.lastHookData();
        assertEq(hookData.length, 32 + 56, "header plus the strkey");

        assertEq(bytes24(_slice(hookData, 0, 24)), bytes24("cctp-forward"), "Circle relays on this marker");
        assertEq(uint32(bytes4(_slice(hookData, 24, 4))), 0, "hook version");
        assertEq(uint32(bytes4(_slice(hookData, 28, 4))), 56, "declared strkey length");
        assertEq(string(_slice(hookData, 32, 56)), RECIPIENT, "the address travels as text");
    }

    function test_hookDataCarriesMuxedLength() public {
        vm.prank(user);
        bridge.bridge(1000e6, RECIPIENT_MUXED, false, 0);

        bytes memory hookData = messenger.lastHookData();
        assertEq(hookData.length, 32 + 69);
        assertEq(uint32(bytes4(_slice(hookData, 28, 4))), 69, "a muxed address is longer");
        assertEq(string(_slice(hookData, 32, 69)), RECIPIENT_MUXED);
    }

    function test_hookDataForMatchesWhatIsSent() public {
        vm.prank(user);
        bridge.bridge(1000e6, RECIPIENT, false, 0);
        assertEq(bridge.hookDataFor(RECIPIENT), messenger.lastHookData());
    }

    // --- Circle's fee, which is an allowance and not a price ------------

    /// @dev The fee lands at the destination, so there is nothing here to ask.
    /// What goes out is the ceiling this contract grants: twenty basis points
    /// of the burn, against the 1.3 Circle has been observed to take.
    function test_authorisesTheAllowanceNotAProbe() public {
        assertEq(bridge.circleFeeAllowance(995e6), 1.99e6);

        vm.prank(user);
        bridge.bridge(1000e6, RECIPIENT, false, 0);
        assertEq(messenger.recorded().maxFee, 1.99e6, "twenty bps of the burn, granted not read");
    }

    /// @dev The messenger on Base has no `getMinFeeAmount`, and it no longer
    /// matters: nothing consults it. A transfer must go through whether the
    /// function is there or not.
    function test_ignoresTheMessengersOwnFeeSetting() public {
        messenger.setMinFee(10); // Circle switches minFee on; irrelevant here

        vm.prank(user);
        bridge.bridge(1000e6, RECIPIENT, false, 0);
        assertEq(messenger.recorded().maxFee, 1.99e6, "still the allowance, not their number");
    }

    /// @dev Circle raises their fee past the current allowance. The answer is
    /// a setter call, not a redeploy — which is the whole reason this is not a
    /// constant.
    function test_allowanceMovesWithoutARedeploy() public {
        vm.prank(owner);
        bridge.setCircleFeeAllowance(40);

        vm.prank(user);
        bridge.bridge(1000e6, RECIPIENT, false, 0);
        assertEq(messenger.recorded().maxFee, 3.98e6);
    }

    function test_allowanceCannotPassTheCeiling() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(StellarBridge.AboveCeiling.selector, uint256(101), uint256(100))
        );
        bridge.setCircleFeeAllowance(101);
    }

    function test_allowanceAtTheCeilingIsAllowed() public {
        vm.prank(owner);
        bridge.setCircleFeeAllowance(100);
        assertEq(bridge.circleFeeAllowance(995e6), 9.95e6);
    }

    function test_onlyOwnerMovesTheAllowance() public {
        vm.prank(user);
        vm.expectRevert();
        bridge.setCircleFeeAllowance(30);
    }

    // --- fast transfer, which Stellar was said not to have ---------------

    /// @dev The claim was that Stellar is standard-only. It is not: a burn at
    /// threshold 1000 attested in 29 seconds on testnet against 25 minutes at
    /// 2000, and Stellar took the unfinalized message. Passing 2000 here would
    /// cost every user that difference for nothing.
    function test_burnsAtSoftFinality() public {
        vm.prank(user);
        bridge.bridge(1000e6, RECIPIENT, false, 0);
        assertEq(messenger.recorded().minFinalityThreshold, 1000, "fast, not hard finality");
    }

    // --- the address is checked before the money moves -------------------

    function test_badAddressRevertsBeforeAnythingMoves() public {
        uint256 before = usdc.balanceOf(user);

        vm.prank(user);
        vm.expectRevert();
        bridge.bridge(1000e6, "GAAACAQDAQAQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB7JZX", false, 0);

        assertEq(usdc.balanceOf(user), before, "no USDC left the user");
        assertEq(messenger.callCount(), 0, "nothing was burned");
        assertEq(bridge.accruedFees(), 0, "no fee was booked");
    }

    function test_rejectsContractAddressAsRecipient() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(StellarStrkey.BadVersion.selector, uint8(0x10)));
        bridge.bridge(1000e6, "CAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB6N4O", false, 0);
    }

    // --- the event the backend runs on -----------------------------------

    event Bridged(
        address indexed user,
        string stellarRecipient,
        uint256 gross,
        uint256 net,
        uint256 fee,
        uint8 recipientVersion,
        bool activate
    );

    /// @dev The funding on the Stellar side is driven off this event, so it
    /// has to carry the address, the amount, and whether it was paid for.
    function test_emitsWhatTheBackendNeeds() public {
        vm.expectEmit(true, false, false, true, address(bridge));
        emit Bridged(user, RECIPIENT, 1000e6, 995e6, 5e6, 0x30, false);

        vm.prank(user);
        bridge.bridge(1000e6, RECIPIENT, false, 0);
    }

    function test_emitsTheActivationItWasPaidFor() public {
        vm.expectEmit(true, false, false, true, address(bridge));
        emit Bridged(user, RECIPIENT, 1000e6, 990e6, 10e6, 0x30, true);

        vm.prank(user);
        bridge.bridge(1000e6, RECIPIENT, true, 5e6);
    }

    // --- fees and ownership ----------------------------------------------

    function test_withdrawFeesToTreasury() public {
        vm.prank(user);
        bridge.bridge(1000e6, RECIPIENT, false, 0);

        vm.prank(owner);
        bridge.withdrawFees(5e6);

        assertEq(usdc.balanceOf(treasury), 5e6);
        assertEq(bridge.accruedFees(), 0);
    }

    function test_cannotWithdrawMoreThanAccrued() public {
        vm.prank(user);
        bridge.bridge(1000e6, RECIPIENT, false, 0);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StellarBridge.ExceedsAccruedFees.selector, uint256(5e6 + 1), uint256(5e6)));
        bridge.withdrawFees(5e6 + 1);
    }

    function test_onlyOwnerWithdraws() public {
        vm.prank(user);
        bridge.bridge(1000e6, RECIPIENT, false, 0);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        bridge.withdrawFees(1);
    }

    /// @dev Renouncing would strand the accrued fees forever.
    function test_cannotRenounceOwnership() public {
        vm.prank(owner);
        vm.expectRevert(StellarBridge.ZeroAddress.selector);
        bridge.renounceOwnership();
    }

    function test_constructorRejectsZeroForwarder() public {
        vm.expectRevert(StellarBridge.ZeroAddress.selector);
        new StellarBridge(owner, address(usdc), address(messenger), bytes32(0), treasury);
    }

    // --- helpers ---------------------------------------------------------

    function _slice(bytes memory data, uint256 start, uint256 length) private pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i = 0; i < length; ++i) {
            out[i] = data[start + i];
        }
    }
}
