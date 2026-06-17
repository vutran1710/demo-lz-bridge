// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./OAppCore.sol";
import "./interfaces/ILayerZeroReceiver.sol";

/// @notice Application base: send/receive plumbing + peer auth. The send path delegates to the
/// Endpoint (which reverts NotImplemented in P0); the receive auth is real.
abstract contract OApp is OAppCore, ILayerZeroReceiver {
    constructor(address ep) OAppCore(ep) {}

    function _lzSend(uint32 dstEid, bytes memory message, bytes memory options)
        internal
        returns (MessagingReceipt memory)
    {
        return endpoint.send{value: msg.value}(
            MessagingParams({
                dstEid: dstEid,
                receiver: peers[dstEid],
                message: message,
                options: options,
                payInLzToken: false
            }),
            msg.sender
        );
    }

    function lzReceive(Origin calldata o, bytes32 guid, bytes calldata message, address executor, bytes calldata extraData)
        external
        payable
    {
        if (msg.sender != address(endpoint)) revert OnlyEndpoint();
        if (o.sender != peers[o.srcEid]) revert OnlyPeer();
        _lzReceive(o, guid, message, executor, extraData);
    }

    function _lzReceive(
        Origin calldata o,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) internal virtual;
}
