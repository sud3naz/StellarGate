// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title StellarStrkey
 * @notice Decodes and checks a Stellar strkey address on-chain.
 *
 * The destination address rides to Stellar inside CCTP hook data as plain
 * UTF-8 text. Nothing on the Stellar side can tell a typo from an address:
 * `MuxedAddress::from_string_bytes` will happily parse any well-formed strkey,
 * and the forwarder will pay it. A wrong-but-valid address loses the money
 * permanently, and a malformed one strands the transfer in a message that can
 * never be delivered.
 *
 * So the checksum is verified here, before the burn. Stellar strkeys carry a
 * CRC16 over the payload precisely so that a mistyped character is caught, and
 * checking it costs a few thousand gas against an irreversible loss. The
 * frontend checks it too; this is the copy that cannot be bypassed.
 *
 * Layout of a strkey, base32 (RFC 4648, no padding) over:
 *
 *     version byte (1) ‖ payload ‖ CRC16-XModem of the two, little-endian (2)
 *
 * Only the two forms that can receive a payment are accepted:
 *
 * | form            | version | payload | decoded | encoded |
 * |-----------------|---------|---------|---------|---------|
 * | `G…` account    | 0x30    | 32      | 35      | 56      |
 * | `M…` muxed      | 0x60    | 40      | 43      | 69      |
 *
 * `M…` is allowed because it is how a memo travels: an exchange deposit needs
 * an identifier, and a payment out of a contract cannot carry a classic memo,
 * so the memo id is folded into the address instead. Contract addresses (`C…`)
 * are rejected: the forwarder pays with a SAC transfer, and routing user funds
 * into an arbitrary contract is not something this bridge should do blindly.
 */
library StellarStrkey {
    /// @notice `G…`, an ordinary Stellar account: version byte 6 << 3.
    uint8 internal constant VERSION_ACCOUNT = 0x30;
    /// @notice `M…`, an account with a memo id folded in: version byte 12 << 3.
    uint8 internal constant VERSION_MUXED = 0x60;

    uint256 internal constant LEN_ACCOUNT = 56;
    uint256 internal constant LEN_MUXED = 69;
    uint256 internal constant DECODED_ACCOUNT = 35;
    uint256 internal constant DECODED_MUXED = 43;

    error BadLength(uint256 length);
    error BadCharacter(uint256 index);
    error BadPadding();
    error BadVersion(uint8 version);
    error BadChecksum(uint16 computed, uint16 expected);

    /**
     * @notice Reverts unless `strkey` is a payable Stellar address.
     * @param strkey The address as the user typed it, e.g. `GABC…`.
     * @return version The version byte, so the caller can tell `G…` from `M…`.
     */
    function validate(string memory strkey) internal pure returns (uint8 version) {
        bytes memory input = bytes(strkey);

        uint256 decodedLength;
        if (input.length == LEN_ACCOUNT) {
            decodedLength = DECODED_ACCOUNT;
        } else if (input.length == LEN_MUXED) {
            decodedLength = DECODED_MUXED;
        } else {
            revert BadLength(input.length);
        }

        bytes memory decoded = _base32Decode(input, decodedLength);

        version = uint8(decoded[0]);
        if (version != VERSION_ACCOUNT && version != VERSION_MUXED) revert BadVersion(version);
        // Length and version must agree: a 56-character `M…` is not a thing.
        if (version == VERSION_ACCOUNT && decodedLength != DECODED_ACCOUNT) revert BadVersion(version);
        if (version == VERSION_MUXED && decodedLength != DECODED_MUXED) revert BadVersion(version);

        // The trailing two bytes are the checksum, stored least significant first.
        uint16 expected = uint16(uint8(decoded[decodedLength - 2])) | (uint16(uint8(decoded[decodedLength - 1])) << 8);
        uint16 computed = _crc16(decoded, decodedLength - 2);
        if (computed != expected) revert BadChecksum(computed, expected);
    }

    /**
     * @dev Base32 per RFC 4648 with no padding, which is what Stellar uses.
     * The trailing bits of the last character are not part of the payload and
     * must be zero; a nonzero remainder means the string was not produced by
     * an encoder and is rejected rather than silently truncated.
     */
    function _base32Decode(bytes memory input, uint256 outLength) private pure returns (bytes memory out) {
        out = new bytes(outLength);

        uint256 buffer;
        uint256 bits;
        uint256 written;

        for (uint256 i = 0; i < input.length; ++i) {
            uint256 value;
            uint8 c = uint8(input[i]);
            if (c >= 0x41 && c <= 0x5A) {
                value = c - 0x41; // 'A'-'Z' -> 0-25
            } else if (c >= 0x32 && c <= 0x37) {
                value = c - 0x32 + 26; // '2'-'7' -> 26-31
            } else {
                revert BadCharacter(i);
            }

            buffer = (buffer << 5) | value;
            bits += 5;

            if (bits >= 8) {
                bits -= 8;
                // Cannot overflow: outLength is derived from input.length above.
                out[written++] = bytes1(uint8(buffer >> bits));
                buffer &= (1 << bits) - 1;
            }
        }

        if (written != outLength || buffer != 0) revert BadPadding();
    }

    /**
     * @dev CRC16-XModem: polynomial 0x1021, zero init, no reflection, no final
     * xor. This is the variant Stellar's SDKs use to build the two checksum
     * bytes, so it is the variant that has to be reproduced here.
     */
    function _crc16(bytes memory data, uint256 length) private pure returns (uint16 crc) {
        for (uint256 i = 0; i < length; ++i) {
            crc ^= uint16(uint8(data[i])) << 8;
            for (uint256 bit = 0; bit < 8; ++bit) {
                // Shifts are unchecked in Solidity, so the high bit falls off
                // on its own, which is what the algorithm wants.
                crc = (crc & 0x8000) != 0 ? (crc << 1) ^ 0x1021 : crc << 1;
            }
        }
    }
}
