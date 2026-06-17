// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IMessageLib.sol";
import "./libraries/PacketCodec.sol";

/// @notice Serializes the canonical packet and emits PacketSent (the source of truth for attestors).
/// Fee model (OQ1): operator-funded, zero on-chain fee for the private network.
contract SendLib is ISendLib {
    address public immutable endpoint;

    error OnlyEndpoint();

    constructor(address _endpoint) {
        endpoint = _endpoint;
    }

    function send(Packet calldata packet, bytes calldata options, bool)
        external
        returns (MessagingFee memory fee, bytes memory encoded)
    {
        if (msg.sender != endpoint) revert OnlyEndpoint();
        encoded = PacketCodec.encode(packet);
        emit PacketSent(encoded, options, address(this));
        fee = MessagingFee({nativeFee: 0, lzTokenFee: 0});
    }

    function quote(Packet calldata, bytes calldata, bool) external pure returns (MessagingFee memory) {
        return MessagingFee({nativeFee: 0, lzTokenFee: 0});
    }

    function setConfig(address, SetConfigParam[] calldata) external {}
}
