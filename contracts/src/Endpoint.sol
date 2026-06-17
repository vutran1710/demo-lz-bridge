// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IEndpoint.sol";
import "./interfaces/IMessageLib.sol";
import "./interfaces/ILayerZeroReceiver.sol";
import "./libraries/PacketCodec.sol";

/// @notice Immutable messaging endpoint. Owns the channel state (nonces, committed payload hashes)
/// and the per-OApp library/config registry. Ordered commit + parked-retry semantics (spec §7).
contract Endpoint is IEndpoint {
    uint32 public immutable eid;

    // ---- config registry ----
    mapping(address => mapping(uint32 => address)) public sendLib; // oapp => dstEid => lib
    mapping(address => mapping(uint32 => address)) public receiveLib; // oapp => srcEid => lib
    mapping(address => address) public delegates;

    // ---- channel state ----
    mapping(address => mapping(uint32 => mapping(bytes32 => uint64))) internal _outboundNonce;
    mapping(address => mapping(uint32 => mapping(bytes32 => uint64))) internal _lazyInboundNonce; // gap-free commit cursor
    mapping(address => mapping(uint32 => mapping(bytes32 => uint64))) internal _executedNonce; // ordered-exec cursor
    mapping(address => mapping(uint32 => mapping(bytes32 => mapping(uint64 => bytes32)))) internal _inboundPayloadHash;

    bytes32 internal constant EMPTY = bytes32(0);
    bytes32 internal constant NIL = bytes32(type(uint256).max); // nilified: committed but non-executable

    error NotImplemented();
    error OnlyReceiveLib();
    error InvalidNonce();
    error PayloadHashMismatch();
    error NotExecutable();
    error OnlyOappOrDelegate();

    event PacketNilified(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce);
    event PacketBurnt(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce);

    constructor(uint32 _eid) {
        eid = _eid;
    }

    modifier onlyOappOrDelegate(address oapp) {
        if (msg.sender != oapp && msg.sender != delegates[oapp]) revert OnlyOappOrDelegate();
        _;
    }

    // ---- SEND PATH ----
    function quote(MessagingParams calldata p, address sender) external view returns (MessagingFee memory) {
        Packet memory packet = _toPacket(p, sender, _outboundNonce[sender][p.dstEid][p.receiver] + 1);
        return ISendLib(sendLib[sender][p.dstEid]).quote(packet, p.options, p.payInLzToken);
    }

    function send(MessagingParams calldata p, address) external payable returns (MessagingReceipt memory rcpt) {
        uint64 nonce = ++_outboundNonce[msg.sender][p.dstEid][p.receiver];
        Packet memory packet = _toPacket(p, msg.sender, nonce);
        (MessagingFee memory fee,) = ISendLib(sendLib[msg.sender][p.dstEid]).send(packet, p.options, p.payInLzToken);
        rcpt = MessagingReceipt({guid: packet.guid, nonce: nonce, fee: fee});
    }

    function _toPacket(MessagingParams calldata p, address sender, uint64 nonce)
        internal
        view
        returns (Packet memory)
    {
        bytes32 guid = PacketCodec.guidOf(nonce, eid, sender, p.dstEid, p.receiver);
        return Packet({
            nonce: nonce,
            srcEid: eid,
            sender: sender,
            dstEid: p.dstEid,
            receiver: p.receiver,
            guid: guid,
            message: p.message
        });
    }

    // ---- RECEIVE PATH ----
    function verify(Origin calldata o, address receiver, bytes32 payloadHash) external {
        if (msg.sender != receiveLib[receiver][o.srcEid]) revert OnlyReceiveLib();
        uint64 lazy = _lazyInboundNonce[receiver][o.srcEid][o.sender];
        if (o.nonce != lazy + 1) revert InvalidNonce(); // gap-free, ordered commit
        _lazyInboundNonce[receiver][o.srcEid][o.sender] = o.nonce;
        _inboundPayloadHash[receiver][o.srcEid][o.sender][o.nonce] = payloadHash;
        emit PacketVerified(o, receiver, payloadHash);
    }

    function lzReceive(
        Origin calldata o,
        address receiver,
        bytes32 guid,
        bytes calldata message,
        bytes calldata extraData
    ) external payable {
        bytes32 committed = _inboundPayloadHash[receiver][o.srcEid][o.sender][o.nonce];
        if (committed == EMPTY || committed == NIL) revert NotExecutable();
        if (PacketCodec.payloadHash(guid, message) != committed) revert PayloadHashMismatch();
        if (o.nonce != _executedNonce[receiver][o.srcEid][o.sender] + 1) revert InvalidNonce(); // ordered exec

        // clear before external call (reentrancy-safe); a receiver revert reverts the whole tx,
        // restoring the committed hash → message stays parked for retry.
        _inboundPayloadHash[receiver][o.srcEid][o.sender][o.nonce] = EMPTY;
        _executedNonce[receiver][o.srcEid][o.sender] = o.nonce;

        ILayerZeroReceiver(receiver).lzReceive{value: msg.value}(o, guid, message, msg.sender, extraData);
        emit PacketDelivered(o, receiver);
    }

    // ---- CHANNEL MGMT (owner/delegate escape hatches) ----
    function skip(address oapp, uint32 srcEid, bytes32 sender, uint64 nonce) external onlyOappOrDelegate(oapp) {
        if (nonce != _lazyInboundNonce[oapp][srcEid][sender] + 1) revert InvalidNonce();
        _lazyInboundNonce[oapp][srcEid][sender] = nonce;
        _executedNonce[oapp][srcEid][sender] = nonce;
    }

    function nilify(address oapp, uint32 srcEid, bytes32 sender, uint64 nonce, bytes32 payloadHash)
        external
        onlyOappOrDelegate(oapp)
    {
        if (_inboundPayloadHash[oapp][srcEid][sender][nonce] != payloadHash) revert PayloadHashMismatch();
        _inboundPayloadHash[oapp][srcEid][sender][nonce] = NIL;
        emit PacketNilified(oapp, srcEid, sender, nonce);
    }

    function burn(address oapp, uint32 srcEid, bytes32 sender, uint64 nonce, bytes32 payloadHash)
        external
        onlyOappOrDelegate(oapp)
    {
        if (_inboundPayloadHash[oapp][srcEid][sender][nonce] != payloadHash) revert PayloadHashMismatch();
        _inboundPayloadHash[oapp][srcEid][sender][nonce] = EMPTY;
        emit PacketBurnt(oapp, srcEid, sender, nonce);
    }

    // ---- CONFIG / REGISTRY ----
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

    // ---- VIEWS ----
    function outboundNonce(address sender, uint32 dstEid, bytes32 receiver) external view returns (uint64) {
        return _outboundNonce[sender][dstEid][receiver];
    }

    function inboundNonce(address receiver, uint32 srcEid, bytes32 sender) external view returns (uint64) {
        return _lazyInboundNonce[receiver][srcEid][sender];
    }

    function inboundPayloadHash(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce)
        external
        view
        returns (bytes32)
    {
        return _inboundPayloadHash[receiver][srcEid][sender][nonce];
    }
}
