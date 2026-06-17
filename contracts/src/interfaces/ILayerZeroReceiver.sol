// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IEndpoint.sol";

interface ILayerZeroReceiver {
    function lzReceive(Origin calldata o, bytes32 guid, bytes calldata message, address executor, bytes calldata extraData)
        external
        payable;
}
