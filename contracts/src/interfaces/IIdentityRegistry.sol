// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice The subset of the ERC-8004 Identity Registry (an ERC-721) that Attest8004
/// uses to decide who owns or operates an agent. `agentId` is the ERC-721 `tokenId`.
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);

    function getApproved(uint256 agentId) external view returns (address);

    function isApprovedForAll(address owner, address operator) external view returns (bool);
}
