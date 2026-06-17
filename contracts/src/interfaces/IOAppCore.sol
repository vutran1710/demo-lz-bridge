// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IOAppCore {
    function setPeer(uint32 eid, bytes32 peer) external;
    function peers(uint32 eid) external view returns (bytes32);
}
