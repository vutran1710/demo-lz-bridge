// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IMessageLib.sol";

/// @notice P0 skeleton. verify/commitVerification withheld until P2; ULN config is real plumbing
/// so the harness can wire the M-of-N attestor set.
contract ReceiveLib is IReceiveLib {
    address public immutable endpoint;

    mapping(address => mapping(uint32 => UlnConfig)) internal _uln; // oapp => srcEid => config

    error NotImplemented();

    constructor(address _endpoint) {
        endpoint = _endpoint;
    }

    function verify(bytes calldata, bytes32, uint64) external pure {
        revert NotImplemented();
    }

    function commitVerification(bytes calldata, bytes32) external pure {
        revert NotImplemented();
    }

    function setConfig(address oapp, SetConfigParam[] calldata params) external {
        for (uint256 i = 0; i < params.length; i++) {
            if (params[i].configType == 2) {
                _uln[oapp][params[i].eid] = abi.decode(params[i].config, (UlnConfig));
            }
        }
    }

    function getUlnConfig(address oapp, uint32 srcEid) external view returns (UlnConfig memory) {
        return _uln[oapp][srcEid];
    }
}
