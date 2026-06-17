// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IMessageLib.sol";

/// @notice P0 skeleton. send/quote withheld until P2; setConfig is no-op plumbing.
contract SendLib is ISendLib {
    address public immutable endpoint;

    error NotImplemented();

    constructor(address _endpoint) {
        endpoint = _endpoint;
    }

    function send(Packet calldata, bytes calldata, bool) external returns (MessagingFee memory, bytes memory) {
        revert NotImplemented();
    }

    function quote(Packet calldata, bytes calldata, bool) external pure returns (MessagingFee memory) {
        revert NotImplemented();
    }

    function setConfig(address, SetConfigParam[] calldata) external {}
}
