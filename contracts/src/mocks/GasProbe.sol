// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/ILayerZeroReceiver.sol";

/// @notice Test receiver that asserts it was given at least `required` gas — lets tests verify the
/// Endpoint forwards exactly the configured lzReceiveGas budget.
contract GasProbe is ILayerZeroReceiver {
    uint256 public required;

    event Got(uint64 nonce, uint256 gasSeen);

    function setRequired(uint256 r) external {
        required = r;
    }

    function lzReceive(Origin calldata o, bytes32, bytes calldata, address, bytes calldata) external payable {
        require(gasleft() >= required, "NEED_GAS");
        emit Got(o.nonce, gasleft());
    }
}
