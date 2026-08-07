// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {StellarStrkey} from "../src/StellarStrkey.sol";

/// @dev The library is internal, so reverts need an external boundary to catch.
contract Harness {
    function validate(string calldata strkey) external pure returns (uint8) {
        return StellarStrkey.validate(strkey);
    }
}

contract StellarStrkeyTest is Test {
    Harness internal harness;

    /// @dev Circle's real USDC issuer on Stellar mainnet. If the checksum
    /// implementation is wrong, this is the vector that says so.
    string internal constant USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    /// @dev Generated from the key 0x0001…1f, checked against a reference
    /// base32 + CRC16 implementation outside Solidity.
    string internal constant GOOD_G = "GAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB7JZX";
    string internal constant GOOD_M = "MAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB6AAAAAAAAAAE2KZ3Q";
    /// @dev Same key encoded as a contract address.
    string internal constant CONTRACT_C = "CAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB6N4O";
    /// @dev GOOD_G with one payload character changed.
    string internal constant BAD_CHECKSUM = "GAAACAQDAQAQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB7JZX";

    function setUp() public {
        harness = new Harness();
    }

    function test_acceptsRealMainnetAccount() public view {
        assertEq(harness.validate(USDC_ISSUER), StellarStrkey.VERSION_ACCOUNT);
    }

    function test_acceptsAccount() public view {
        assertEq(harness.validate(GOOD_G), StellarStrkey.VERSION_ACCOUNT);
    }

    function test_acceptsMuxed() public view {
        assertEq(harness.validate(GOOD_M), StellarStrkey.VERSION_MUXED);
    }

    /// @dev A contract address is a valid strkey and a valid Stellar address,
    /// which is exactly why it has to be rejected explicitly rather than left
    /// to the checksum.
    function test_rejectsContractAddress() public {
        vm.expectRevert(abi.encodeWithSelector(StellarStrkey.BadVersion.selector, uint8(0x10)));
        harness.validate(CONTRACT_C);
    }

    function test_rejectsBadChecksum() public {
        vm.expectRevert();
        harness.validate(BAD_CHECKSUM);
    }

    function test_rejectsShortString() public {
        vm.expectRevert(abi.encodeWithSelector(StellarStrkey.BadLength.selector, uint256(55)));
        harness.validate("GAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB7JZ");
    }

    function test_rejectsEmptyString() public {
        vm.expectRevert(abi.encodeWithSelector(StellarStrkey.BadLength.selector, uint256(0)));
        harness.validate("");
    }

    /// @dev Stellar's base32 alphabet has no 0, 1, 8 or 9, which is why the
    /// vanity grinder in the sibling project cannot end an address in 0000.
    function test_rejectsCharacterOutsideAlphabet() public {
        string memory withZero = "G0AACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB7JZX";
        vm.expectRevert(abi.encodeWithSelector(StellarStrkey.BadCharacter.selector, uint256(1)));
        harness.validate(withZero);
    }

    function test_rejectsLowercase() public {
        string memory lower = "gAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB7JZX";
        vm.expectRevert(abi.encodeWithSelector(StellarStrkey.BadCharacter.selector, uint256(0)));
        harness.validate(lower);
    }

    /**
     * @dev 69 characters carry 345 bits but a muxed address is only 344, so
     * the last character has one spare bit that an encoder always leaves at
     * zero. Setting it changes no decoded byte and so passes the checksum;
     * only the padding check catches it. Q is 16, R is 17.
     */
    function test_rejectsNonZeroPadding() public {
        string memory padded = "MAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB6AAAAAAAAAAE2KZ3R";
        vm.expectRevert(StellarStrkey.BadPadding.selector);
        harness.validate(padded);
    }

    /// @dev Every single-character change must be caught. This is the whole
    /// point of validating on-chain: the money is gone if one gets through.
    function testFuzz_singleCharacterTypoIsRejected(uint8 position, uint8 replacement) public {
        bytes memory alphabet = bytes("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
        bytes memory candidate = bytes(GOOD_G);
        uint256 index = bound(position, 0, candidate.length - 1);
        bytes1 replacementChar = alphabet[bound(replacement, 0, alphabet.length - 1)];
        vm.assume(candidate[index] != replacementChar);
        candidate[index] = replacementChar;

        vm.expectRevert();
        harness.validate(string(candidate));
    }
}
