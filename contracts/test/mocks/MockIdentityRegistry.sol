// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Stand-in for the ERC-8004 Identity Registry in unit tests. It uses OpenZeppelin's
/// ERC721, so ownership, approvals and transfers behave exactly as in the canonical registry.
/// Agent IDs are sequential from 1.
contract MockIdentityRegistry is ERC721("AgentIdentity", "AGENT") {
    uint256 private _lastId;

    function register() external returns (uint256 agentId) {
        agentId = ++_lastId;
        _mint(msg.sender, agentId);
    }
}
