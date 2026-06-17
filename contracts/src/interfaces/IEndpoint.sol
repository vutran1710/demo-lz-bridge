// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct MessagingParams { uint32 dstEid; bytes32 receiver; bytes message; bytes options; bool payInLzToken; }
struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }
struct MessagingReceipt { bytes32 guid; uint64 nonce; MessagingFee fee; }
struct Origin { uint32 srcEid; bytes32 sender; uint64 nonce; }
struct SetConfigParam { uint32 eid; uint32 configType; bytes config; }

// ReceiveLib config decoded from SetConfigParam.config for configType = CONFIG_TYPE_ULN (=2)
struct UlnConfig {
    uint64 confirmations;
    address[] requiredAttestors; // all must sign
    address[] optionalAttestors; // X of these must sign
    uint8 optionalThreshold; // X
}

event PacketSent(bytes encodedPacket, bytes options, address sendLibrary);
event PacketVerified(Origin origin, address receiver, bytes32 payloadHash); // emitted on commit
event PacketDelivered(Origin origin, address receiver); // emitted on successful execute
event LzReceiveAlert(address indexed receiver, address indexed executor, Origin origin, bytes32 guid, bytes reason);

interface IEndpoint {
    function eid() external view returns (uint32);

    // SEND (called by OApp, same chain)
    function quote(MessagingParams calldata p, address sender) external view returns (MessagingFee memory);
    function send(MessagingParams calldata p, address refundAddress) external payable returns (MessagingReceipt memory);

    // RECEIVE
    function verify(Origin calldata o, address receiver, bytes32 payloadHash) external; // called by ReceiveLib on threshold
    function lzReceive(Origin calldata o, address receiver, bytes32 guid, bytes calldata message, bytes calldata extraData)
        external
        payable; // called by Executor

    // CHANNEL MGMT (OApp/delegate)
    function skip(address oapp, uint32 srcEid, bytes32 sender, uint64 nonce) external;
    function nilify(address oapp, uint32 srcEid, bytes32 sender, uint64 nonce, bytes32 payloadHash) external;
    function burn(address oapp, uint32 srcEid, bytes32 sender, uint64 nonce, bytes32 payloadHash) external;

    // CONFIG / REGISTRY (OApp owner/delegate)
    function setSendLibrary(address oapp, uint32 eid, address lib) external;
    function setReceiveLibrary(address oapp, uint32 eid, address lib, uint256 gracePeriod) external;
    function setConfig(address oapp, address lib, SetConfigParam[] calldata params) external;
    function setDelegate(address delegate) external;

    // VIEWS
    function outboundNonce(address sender, uint32 dstEid, bytes32 receiver) external view returns (uint64);
    function inboundNonce(address receiver, uint32 srcEid, bytes32 sender) external view returns (uint64);
    function inboundPayloadHash(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce)
        external
        view
        returns (bytes32);
}
