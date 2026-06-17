// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/libraries/PacketCodec.sol";
import "../src/interfaces/IMessageLib.sol";

contract CodecTest is Test {
    function test_guid_matches_packed_keccak() public pure {
        uint64 nonce = 7;
        uint32 srcEid = 1;
        address sender = address(0xBEEF);
        uint32 dstEid = 2;
        bytes32 receiver = bytes32(uint256(uint160(address(0xCAFE))));
        bytes32 expected = keccak256(abi.encodePacked(nonce, srcEid, bytes32(uint256(uint160(sender))), dstEid, receiver));
        assertEq(PacketCodec.guidOf(nonce, srcEid, sender, dstEid, receiver), expected);
    }

    function test_payloadHash_is_keccak_guid_concat_message() public pure {
        bytes32 guid = keccak256("g");
        bytes memory message = hex"01020304";
        assertEq(PacketCodec.payloadHash(guid, message), keccak256(abi.encodePacked(guid, message)));
    }

    function test_header_is_81_bytes_and_decodes_roundtrip() public view {
        Packet memory p = Packet({
            nonce: 42,
            srcEid: 1,
            sender: address(0x1234),
            dstEid: 2,
            receiver: bytes32(uint256(uint160(address(0x5678)))),
            guid: bytes32(0),
            message: hex"aabb"
        });
        bytes memory h = PacketCodec.header(p);
        assertEq(h.length, 81);
        (Origin memory o, bytes32 receiver, uint32 dstEid) = this.decode(h);
        assertEq(o.nonce, 42);
        assertEq(o.srcEid, 1);
        assertEq(o.sender, bytes32(uint256(uint160(address(0x1234)))));
        assertEq(dstEid, 2);
        assertEq(receiver, bytes32(uint256(uint160(address(0x5678)))));
    }

    function decode(bytes calldata h) external pure returns (Origin memory, bytes32, uint32) {
        return PacketCodec.decodeHeader(h);
    }

    function testFuzz_guid_deterministic(uint64 nonce, uint32 srcEid, address sender, uint32 dstEid, bytes32 receiver)
        public
        pure
    {
        assertEq(
            PacketCodec.guidOf(nonce, srcEid, sender, dstEid, receiver),
            PacketCodec.guidOf(nonce, srcEid, sender, dstEid, receiver)
        );
    }
}
