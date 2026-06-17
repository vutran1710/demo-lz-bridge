// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IEndpoint.sol"; // SetConfigParam

/// @notice Executor configuration per (oapp, dstEid). `lzReceiveGas` is the gas the executor must
/// supply to the receiver's lzReceive; 0 means "forward available gas" (back-compat).
struct ExecutorConfigData {
    uint32 maxMessageSize;
    address executor;
    uint128 lzReceiveGas;
}

uint32 constant CONFIG_TYPE_EXECUTOR = 1;

interface IPriceFeed {
    function gasPrice(uint32 dstEid) external view returns (uint256);
}

interface IExecutorConfig {
    function setConfig(address oapp, SetConfigParam[] calldata params) external;
    function getConfig(address oapp, uint32 dstEid) external view returns (ExecutorConfigData memory);
}
