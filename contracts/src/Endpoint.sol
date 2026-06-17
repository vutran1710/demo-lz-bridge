// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IEndpoint.sol";
import "./interfaces/IMessageLib.sol";

/// @notice Immutable messaging endpoint. P0 skeleton: config registry is real plumbing;
/// the message path (send/verify/lzReceive/escape hatches) reverts NotImplemented until P2.
contract Endpoint is IEndpoint {
    uint32 public immutable eid;

    // ---- config registry (real plumbing) ----
    mapping(address => mapping(uint32 => address)) public sendLib; // oapp => dstEid => lib
    mapping(address => mapping(uint32 => address)) public receiveLib; // oapp => srcEid => lib
    mapping(address => address) public delegates;

    error NotImplemented();

    constructor(uint32 _eid) {
        eid = _eid;
    }

    // ---- SEND PATH (withheld until P2) ----
    function quote(MessagingParams calldata, address) external pure returns (MessagingFee memory) {
        revert NotImplemented();
    }

    function send(MessagingParams calldata, address) external payable returns (MessagingReceipt memory) {
        revert NotImplemented();
    }

    // ---- RECEIVE PATH (withheld until P2) ----
    function verify(Origin calldata, address, bytes32) external pure {
        revert NotImplemented();
    }

    function lzReceive(Origin calldata, address, bytes32, bytes calldata, bytes calldata) external payable {
        revert NotImplemented();
    }

    // ---- CHANNEL MGMT (withheld until P2) ----
    function skip(address, uint32, bytes32, uint64) external pure {
        revert NotImplemented();
    }

    function nilify(address, uint32, bytes32, uint64, bytes32) external pure {
        revert NotImplemented();
    }

    function burn(address, uint32, bytes32, uint64, bytes32) external pure {
        revert NotImplemented();
    }

    // ---- CONFIG / REGISTRY (real plumbing) ----
    function setSendLibrary(address oapp, uint32 _eid, address lib) external {
        sendLib[oapp][_eid] = lib;
    }

    function setReceiveLibrary(address oapp, uint32 _eid, address lib, uint256) external {
        receiveLib[oapp][_eid] = lib;
    }

    function setConfig(address oapp, address lib, SetConfigParam[] calldata params) external {
        IReceiveLib(lib).setConfig(oapp, params);
    }

    function setDelegate(address delegate) external {
        delegates[msg.sender] = delegate;
    }

    // ---- VIEWS (default state until P2) ----
    function outboundNonce(address, uint32, bytes32) external pure returns (uint64) {
        return 0;
    }

    function inboundNonce(address, uint32, bytes32) external pure returns (uint64) {
        return 0;
    }

    function inboundPayloadHash(address, uint32, bytes32, uint64) external pure returns (bytes32) {
        return bytes32(0);
    }
}
