// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../OApp.sol";

/// @notice Test OApp: re-emits received bytes so acceptance tests can assert intact, in-order delivery.
contract AppEcho is OApp {
    event Echoed(uint32 srcEid, bytes32 sender, uint64 nonce, bytes message);

    constructor(address ep) OApp(ep) {}

    function sendMessage(uint32 dstEid, bytes calldata message) external payable {
        _lzSend(dstEid, message, "");
    }

    function _lzReceive(Origin calldata o, bytes32, bytes calldata message, address, bytes calldata) internal override {
        emit Echoed(o.srcEid, o.sender, o.nonce, message);
    }
}
