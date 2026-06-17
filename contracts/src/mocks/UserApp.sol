// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../OApp.sol";

/// @notice Playground end-user OApp: send arbitrary bytes to a destination chain and record every
/// received message (with its source + sender) for the receiver UI.
contract UserApp is OApp {
    event Received(uint32 srcEid, uint64 nonce, bytes32 sender, bytes message);

    constructor(address ep) OApp(ep) {}

    function sendMessage(uint32 dstEid, bytes calldata payload) external payable {
        _lzSend(dstEid, payload, "");
    }

    function _lzReceive(Origin calldata o, bytes32, bytes calldata message, address, bytes calldata)
        internal
        override
    {
        emit Received(o.srcEid, o.nonce, o.sender, message);
    }
}
