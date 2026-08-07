// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {StellarBridge} from "../src/StellarBridge.sol";

/**
 * @title Deploy
 * @notice Deploys {StellarBridge}, and refuses to guess at anything.
 *
 * Every argument is read from the environment and none has a default. That is
 * the point rather than an inconvenience: a script that falls back to a
 * sensible-looking address is a script that will eventually deploy a bridge
 * whose fees go somewhere nobody chose. The forwarder in particular is a raw
 * 32-byte contract id and looks like any other word — getting it wrong sends
 * every burn to an address that will never mint.
 *
 * It also checks the pieces answer before writing anything down, because a
 * constructor cannot tell a real token from an address that happens to have
 * code, and finding out after deployment is expensive in a way finding out
 * before is not.
 *
 * Usage, with the network named explicitly rather than inferred:
 *
 *     BRIDGE_OWNER=0x… BRIDGE_TREASURY=0x… \
 *     BRIDGE_USDC=0x… BRIDGE_MESSENGER=0x… BRIDGE_FORWARDER=0x… \
 *     forge script script/Deploy.s.sol --rpc-url base_sepolia \
 *       --account <keystore> --broadcast
 */
contract Deploy is Script {
    function run() external returns (StellarBridge bridge) {
        address owner = vm.envAddress("BRIDGE_OWNER");
        address treasury = vm.envAddress("BRIDGE_TREASURY");
        address usdc = vm.envAddress("BRIDGE_USDC");
        address messenger = vm.envAddress("BRIDGE_MESSENGER");
        bytes32 forwarder = vm.envBytes32("BRIDGE_FORWARDER");

        // A token that cannot say how many decimals it has is not the token
        // this contract does arithmetic in.
        (bool ok, bytes memory result) = usdc.staticcall(abi.encodeWithSignature("decimals()"));
        require(ok && result.length == 32, "BRIDGE_USDC does not look like a token");
        require(abi.decode(result, (uint8)) == 6, "BRIDGE_USDC is not six decimals");

        require(messenger.code.length > 0, "BRIDGE_MESSENGER has no code");
        require(forwarder != bytes32(0), "BRIDGE_FORWARDER is zero");

        console2.log("owner    ", owner);
        console2.log("treasury ", treasury);
        console2.log("usdc     ", usdc);
        console2.log("messenger", messenger);
        console2.logBytes32(forwarder);

        vm.startBroadcast();
        bridge = new StellarBridge(owner, usdc, messenger, forwarder, treasury);
        vm.stopBroadcast();

        console2.log("StellarBridge", address(bridge));
        console2.log("finality     ", bridge.FINALITY_FAST());
        console2.log("circle bps   ", bridge.circleFeeAllowanceBps());
    }
}
