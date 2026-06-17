// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IEndpoint.sol";
import "../interfaces/IMessageLib.sol";

/// @notice Clean-room implementation of the packet wire format (spec §4), byte-compatible with
/// LayerZero's PacketV1Codec layout. Header = 81 bytes, then guid (32), then message.
library PacketCodec {
    uint8 internal constant VERSION = 1;

    function guidOf(uint64 nonce, uint32 srcEid, address sender, uint32 dstEid, bytes32 receiver)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(nonce, srcEid, bytes32(uint256(uint160(sender))), dstEid, receiver)
        );
    }

    function header(Packet memory p) internal pure returns (bytes memory) {
        return abi.encodePacked(
            VERSION, p.nonce, p.srcEid, bytes32(uint256(uint160(p.sender))), p.dstEid, p.receiver
        );
    }

    function payloadHash(bytes32 guid, bytes memory message) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(guid, message));
    }

    function encode(Packet memory p) internal pure returns (bytes memory) {
        return abi.encodePacked(header(p), p.guid, p.message);
    }

    /// @notice Decode the 81-byte header into an Origin + receiver + dstEid.
    function decodeHeader(bytes calldata h)
        internal
        pure
        returns (Origin memory o, bytes32 receiver, uint32 dstEid)
    {
        require(h.length >= 81 && uint8(h[0]) == VERSION, "BAD_HEADER");
        o.nonce = uint64(bytes8(h[1:9]));
        o.srcEid = uint32(bytes4(h[9:13]));
        o.sender = bytes32(h[13:45]);
        dstEid = uint32(bytes4(h[45:49]));
        receiver = bytes32(h[49:81]);
    }
}
