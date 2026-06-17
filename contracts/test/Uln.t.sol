// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ReceiveLib.sol";
import "../src/Endpoint.sol";
import "../src/libraries/PacketCodec.sol";
import "../src/interfaces/IMessageLib.sol";

contract UlnTest is Test {
    Endpoint endpoint;
    ReceiveLib lib;
    address receiver = address(0xABCD);
    uint32 constant SRC = 1;
    address a1 = address(0xA1);
    address a2 = address(0xA2);
    address a3 = address(0xA3);
    address stranger = address(0xDEAD);

    function setUp() public {
        endpoint = new Endpoint(2, address(0));
        lib = new ReceiveLib(address(endpoint));
        // wire receiveLib + 2-of-3 ULN config for receiver <- SRC
        endpoint.setReceiveLibrary(receiver, SRC, address(lib), 0);
        address[] memory optional = new address[](3);
        optional[0] = a1;
        optional[1] = a2;
        optional[2] = a3;
        UlnConfig memory c = UlnConfig({
            confirmations: 1,
            requiredAttestors: new address[](0),
            optionalAttestors: optional,
            optionalThreshold: 2
        });
        SetConfigParam[] memory params = new SetConfigParam[](1);
        params[0] = SetConfigParam({eid: SRC, configType: 2, config: abi.encode(c)});
        endpoint.setConfig(receiver, address(lib), params);
    }

    function _header(uint64 nonce) internal view returns (bytes memory) {
        Packet memory p = Packet({
            nonce: nonce,
            srcEid: SRC,
            sender: address(0x1111),
            dstEid: 2,
            receiver: bytes32(uint256(uint160(receiver))),
            guid: bytes32(0),
            message: ""
        });
        return PacketCodec.header(p);
    }

    function test_nonmember_cannot_verify() public {
        bytes memory h = _header(1);
        vm.prank(stranger);
        vm.expectRevert(ReceiveLib.NotAVerifier.selector);
        lib.verify(h, keccak256("p"), 1);
    }

    function test_under_threshold_reverts_commit() public {
        bytes memory h = _header(1);
        bytes32 ph = keccak256("p");
        vm.prank(a1);
        lib.verify(h, ph, 1);
        vm.expectRevert(ReceiveLib.ThresholdNotMet.selector);
        lib.commitVerification(h, ph);
    }

    function test_verifiable_falseUntilThreshold_thenTrue() public {
        bytes memory h = _header(1);
        bytes32 ph = keccak256("p");
        assertFalse(lib.verifiable(h, ph));
        vm.prank(a1);
        lib.verify(h, ph, 1);
        assertFalse(lib.verifiable(h, ph)); // 1 of 2
        vm.prank(a2);
        lib.verify(h, ph, 1);
        assertTrue(lib.verifiable(h, ph)); // threshold met, not committed
        lib.commitVerification(h, ph);
        assertFalse(lib.verifiable(h, ph)); // committed → no longer pending
    }

    function test_exact_threshold_commits_and_double_commit_reverts() public {
        bytes memory h = _header(1);
        bytes32 ph = keccak256("p");
        vm.prank(a1);
        lib.verify(h, ph, 1);
        vm.prank(a2);
        lib.verify(h, ph, 1);
        lib.commitVerification(h, ph); // commits nonce 1 into endpoint
        assertEq(endpoint.inboundPayloadHash(receiver, SRC, bytes32(uint256(uint160(address(0x1111)))), 1), ph);
        vm.expectRevert(ReceiveLib.AlreadyCommitted.selector);
        lib.commitVerification(h, ph);
    }
}
