// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/Endpoint.sol";
import "../src/ReceiveLib.sol";
import "../src/ExecutorConfig.sol";
import "../src/libraries/PacketCodec.sol";
import "../src/interfaces/IExecutor.sol";
import "../src/mocks/GasProbe.sol";

contract ExecutorConfigTest is Test {
    Endpoint endpoint;
    ReceiveLib lib;
    ExecutorConfig ec;
    GasProbe probe;
    uint32 constant SRC = 1;
    uint32 constant DST = 2;
    address sender = address(0x1111);
    address a1 = address(0xA1);

    function setUp() public {
        ec = new ExecutorConfig();
        endpoint = new Endpoint(DST, address(ec));
        lib = new ReceiveLib(address(endpoint));
        probe = new GasProbe();

        endpoint.setReceiveLibrary(address(probe), SRC, address(lib), 0);
        // 1-of-1 ULN for the probe
        address[] memory optional = new address[](1);
        optional[0] = a1;
        UlnConfig memory u = UlnConfig({
            confirmations: 1,
            requiredAttestors: new address[](0),
            optionalAttestors: optional,
            optionalThreshold: 1
        });
        SetConfigParam[] memory up = new SetConfigParam[](1);
        up[0] = SetConfigParam({eid: SRC, configType: 2, config: abi.encode(u)});
        endpoint.setConfig(address(probe), address(lib), up);
    }

    function _setExecGas(uint128 gasBudget) internal {
        ExecutorConfigData memory d =
            ExecutorConfigData({maxMessageSize: 10000, executor: address(0xE), lzReceiveGas: gasBudget});
        SetConfigParam[] memory p = new SetConfigParam[](1);
        p[0] = SetConfigParam({eid: DST, configType: CONFIG_TYPE_EXECUTOR, config: abi.encode(d)});
        // route to the ExecutorConfig registry (configType 1)
        endpoint.setConfig(address(probe), address(ec), p);
    }

    function test_setConfig_decodesAndStores() public {
        _setExecGas(123456);
        ExecutorConfigData memory got = ec.getConfig(address(probe), DST);
        assertEq(got.lzReceiveGas, 123456);
        assertEq(got.maxMessageSize, 10000);
        assertEq(got.executor, address(0xE));
    }

    function _commit(bytes memory message) internal returns (bytes32 guid, Origin memory o) {
        uint64 nonce = 1;
        guid = PacketCodec.guidOf(nonce, SRC, sender, DST, bytes32(uint256(uint160(address(probe)))));
        Packet memory pk = Packet({
            nonce: nonce,
            srcEid: SRC,
            sender: sender,
            dstEid: DST,
            receiver: bytes32(uint256(uint160(address(probe)))),
            guid: guid,
            message: message
        });
        bytes memory header = PacketCodec.header(pk);
        bytes32 ph = PacketCodec.payloadHash(guid, message);
        vm.prank(a1);
        lib.verify(header, ph, 1);
        lib.commitVerification(header, ph);
        o = Origin({srcEid: SRC, sender: bytes32(uint256(uint160(sender))), nonce: nonce});
    }

    function test_lzReceive_enforcesGasBudget() public {
        _setExecGas(100000); // small budget
        bytes memory message = hex"abcd";
        (bytes32 guid, Origin memory o) = _commit(message);

        // probe demands more gas than the budget → delivery reverts (parked)
        probe.setRequired(1_000_000);
        vm.expectRevert(); // OOG / NEED_GAS inside the gas-capped call
        endpoint.lzReceive{gas: 5_000_000}(o, address(probe), guid, message, "");

        // hash remains committed (parked) since the tx reverted
        assertEq(
            endpoint.inboundPayloadHash(address(probe), SRC, bytes32(uint256(uint160(sender))), 1),
            PacketCodec.payloadHash(guid, message)
        );

        // lower the demand below the budget → delivery succeeds and clears
        probe.setRequired(20000);
        endpoint.lzReceive{gas: 5_000_000}(o, address(probe), guid, message, "");
        assertEq(endpoint.inboundPayloadHash(address(probe), SRC, bytes32(uint256(uint160(sender))), 1), bytes32(0));
    }
}
