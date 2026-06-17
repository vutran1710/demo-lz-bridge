// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IMessageLib.sol";
import "./interfaces/IEndpoint.sol";
import "./libraries/PacketCodec.sol";

/// @notice Accumulates attestor verifications and, on M-of-N threshold, commits the payload hash
/// to the Endpoint. M-of-N = all required attestors + optionalThreshold-of-optional (spec §5.3).
contract ReceiveLib is IReceiveLib {
    IEndpoint public immutable endpoint;

    mapping(address => mapping(uint32 => UlnConfig)) internal _uln; // oapp => srcEid => config
    // headerHash => payloadHash => attestor => verified
    mapping(bytes32 => mapping(bytes32 => mapping(address => bool))) public verified;
    // committed guard: headerHash => payloadHash => committed
    mapping(bytes32 => mapping(bytes32 => bool)) public committed;

    error NotAVerifier();
    error ThresholdNotMet();
    error AlreadyCommitted();
    error WrongDestination();

    constructor(address _endpoint) {
        endpoint = IEndpoint(_endpoint);
    }

    function verify(bytes calldata packetHeader, bytes32 payloadHash, uint64) external {
        (Origin memory o, bytes32 receiver32,) = PacketCodec.decodeHeader(packetHeader);
        address receiver = address(uint160(uint256(receiver32)));
        if (!_isVerifier(_uln[receiver][o.srcEid], msg.sender)) revert NotAVerifier();
        verified[keccak256(packetHeader)][payloadHash][msg.sender] = true;
    }

    function commitVerification(bytes calldata packetHeader, bytes32 payloadHash) external {
        (Origin memory o, bytes32 receiver32, uint32 dstEid) = PacketCodec.decodeHeader(packetHeader);
        if (dstEid != endpoint.eid()) revert WrongDestination();
        address receiver = address(uint160(uint256(receiver32)));
        bytes32 headerHash = keccak256(packetHeader);
        if (committed[headerHash][payloadHash]) revert AlreadyCommitted();
        if (!_thresholdMet(headerHash, payloadHash, _uln[receiver][o.srcEid])) revert ThresholdNotMet();
        committed[headerHash][payloadHash] = true;
        endpoint.verify(o, receiver, payloadHash);
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

    /// @notice True when the M-of-N threshold is met but the message is not yet committed.
    /// Lets the Executor poll readiness instead of blind-submitting commitVerification.
    function verifiable(bytes calldata packetHeader, bytes32 payloadHash) external view returns (bool) {
        (Origin memory o, bytes32 receiver32,) = PacketCodec.decodeHeader(packetHeader);
        bytes32 headerHash = keccak256(packetHeader);
        if (committed[headerHash][payloadHash]) return false;
        address receiver = address(uint160(uint256(receiver32)));
        return _thresholdMet(headerHash, payloadHash, _uln[receiver][o.srcEid]);
    }

    function _isVerifier(UlnConfig memory c, address who) internal pure returns (bool) {
        for (uint256 i = 0; i < c.requiredAttestors.length; i++) {
            if (c.requiredAttestors[i] == who) return true;
        }
        for (uint256 i = 0; i < c.optionalAttestors.length; i++) {
            if (c.optionalAttestors[i] == who) return true;
        }
        return false;
    }

    function _thresholdMet(bytes32 headerHash, bytes32 payloadHash, UlnConfig memory c)
        internal
        view
        returns (bool)
    {
        // all required attestors must have verified
        for (uint256 i = 0; i < c.requiredAttestors.length; i++) {
            if (!verified[headerHash][payloadHash][c.requiredAttestors[i]]) return false;
        }
        // at least optionalThreshold of optional attestors
        if (c.optionalThreshold == 0) return true;
        uint256 count;
        for (uint256 i = 0; i < c.optionalAttestors.length; i++) {
            if (verified[headerHash][payloadHash][c.optionalAttestors[i]]) count++;
        }
        return count >= c.optionalThreshold;
    }
}
