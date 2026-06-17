// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IOAppCore.sol";
import "./interfaces/IEndpoint.sol";

/// @notice Peer registry + ownership. Real plumbing from P0.
abstract contract OAppCore is IOAppCore {
    IEndpoint public immutable endpoint;
    address public owner;
    mapping(uint32 => bytes32) public peers;

    error OnlyOwner();
    error OnlyEndpoint();
    error OnlyPeer();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(address _endpoint) {
        endpoint = IEndpoint(_endpoint);
        owner = msg.sender;
    }

    function setPeer(uint32 eid, bytes32 peer) external onlyOwner {
        peers[eid] = peer;
    }
}
