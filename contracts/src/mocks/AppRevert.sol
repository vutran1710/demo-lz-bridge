// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../OApp.sol";

/// @notice Test OApp: reverts in _lzReceive on demand to exercise park/retry semantics.
contract AppRevert is OApp {
    bool public failing = true;

    event Received(uint64 nonce);

    constructor(address ep) OApp(ep) {}

    function setFailing(bool f) external {
        failing = f;
    }

    function sendMessage(uint32 dstEid, bytes calldata message) external payable {
        _lzSend(dstEid, message, "");
    }

    function _lzReceive(Origin calldata o, bytes32, bytes calldata, address, bytes calldata) internal override {
        require(!failing, "APP_REVERT");
        emit Received(o.nonce);
    }
}
