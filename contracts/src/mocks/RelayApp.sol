// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../OApp.sol";

/// @notice Ring/composition test OApp: on receive it emits Received AND, while hops remain, forwards
/// the payload to the next chain. Message layout: [hops:1 byte][data]. Lets an e2e drive A→B→C→A
/// and validate receipt on each chain.
contract RelayApp is OApp {
    uint32 public nextEid;

    event Received(uint32 srcEid, uint64 nonce, bytes data);

    constructor(address ep) OApp(ep) {}

    function setNextEid(uint32 e) external {
        nextEid = e;
    }

    /// Kick off the ring: send [hops][data] to firstEid.
    function start(uint32 firstEid, uint8 hops, bytes calldata data) external payable {
        _lzSend(firstEid, abi.encodePacked(hops, data), "");
    }

    function _lzReceive(Origin calldata o, bytes32, bytes calldata message, address, bytes calldata)
        internal
        override
    {
        uint8 hops = uint8(message[0]);
        bytes calldata data = message[1:];
        emit Received(o.srcEid, o.nonce, data);
        if (hops > 0 && nextEid != 0) {
            _lzSend(nextEid, abi.encodePacked(hops - 1, data), "");
        }
    }
}
