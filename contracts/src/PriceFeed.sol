// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IExecutor.sol";

/// @notice Minimal static price feed for the private network. Structured so fees can be enabled
/// later (P6) without redesign; values are admin-set.
contract PriceFeed is IPriceFeed {
    mapping(uint32 => uint256) internal _gasPrice;

    function setGasPrice(uint32 dstEid, uint256 p) external {
        _gasPrice[dstEid] = p;
    }

    function gasPrice(uint32 dstEid) external view returns (uint256) {
        return _gasPrice[dstEid];
    }
}
