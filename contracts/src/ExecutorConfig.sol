// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IExecutor.sol";
import "./interfaces/IEndpoint.sol";

/// @notice Per-(oapp, dstEid) executor configuration registry. Set via Endpoint.setConfig with
/// configType = CONFIG_TYPE_EXECUTOR (the Endpoint forwards to this contract).
contract ExecutorConfig is IExecutorConfig {
    mapping(address => mapping(uint32 => ExecutorConfigData)) internal _cfg;

    function setConfig(address oapp, SetConfigParam[] calldata params) external {
        for (uint256 i = 0; i < params.length; i++) {
            if (params[i].configType == CONFIG_TYPE_EXECUTOR) {
                _cfg[oapp][params[i].eid] = abi.decode(params[i].config, (ExecutorConfigData));
            }
        }
    }

    function getConfig(address oapp, uint32 dstEid) external view returns (ExecutorConfigData memory) {
        return _cfg[oapp][dstEid];
    }
}
