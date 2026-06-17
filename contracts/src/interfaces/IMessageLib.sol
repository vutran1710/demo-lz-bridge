// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IEndpoint.sol";

struct Packet {
    uint64 nonce;
    uint32 srcEid;
    address sender;
    uint32 dstEid;
    bytes32 receiver;
    bytes32 guid;
    bytes message;
}

interface ISendLib {
    function send(Packet calldata packet, bytes calldata options, bool payInLzToken)
        external
        returns (MessagingFee memory fee, bytes memory encodedPacket);
    function quote(Packet calldata packet, bytes calldata options, bool payInLzToken)
        external
        view
        returns (MessagingFee memory);
    function setConfig(address oapp, SetConfigParam[] calldata params) external;
}

interface IReceiveLib {
    function verify(bytes calldata packetHeader, bytes32 payloadHash, uint64 confirmations) external;
    function commitVerification(bytes calldata packetHeader, bytes32 payloadHash) external;
    function setConfig(address oapp, SetConfigParam[] calldata params) external;
    function getUlnConfig(address oapp, uint32 srcEid) external view returns (UlnConfig memory);
}
