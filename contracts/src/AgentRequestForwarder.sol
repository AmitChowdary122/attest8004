// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IValidationRegistry} from "./interfaces/IValidationRegistry.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title AgentRequestForwarder
/// @notice Lets an agent's hot key request validations for that agent, without giving the key any
/// power over the agent itself (SPEC §4.4). EIP-8004 accepts `validationRequest` only from the
/// agent's owner or an ERC-721 operator, and an operator can also transfer the agent. So the owner
/// makes this contract the operator instead, once, with `setApprovalForAll(forwarder, true)`, and
/// registers one hot key per agent with `setAgentKey`. The forwarder exposes nothing but that and
/// `request`, which makes exactly one call: `validationRequest` on the fixed ValidationRegistry.
/// @dev Immutable, no admin, holds no funds. A key works only while the owner who set it still owns
/// the agent: after a transfer it is stale, even if the new owner has also approved this contract.
/// If the agent returns to that owner, the key works again; the owner can revoke it at any time with
/// `setAgentKey(agentId, address(0))`. The approval covers all of the owner's agents (ARCHITECTURE §7).
contract AgentRequestForwarder {
    struct AgentKey {
        address key;
        /// The owner who set the key. The key is valid only while this is still `ownerOf(agentId)`.
        address owner;
    }

    IValidationRegistry public immutable validationRegistry;
    /// The ValidationRegistry's own Identity Registry, so the two can't disagree about ownership.
    IIdentityRegistry public immutable identityRegistry;

    mapping(uint256 agentId => AgentKey) public agentKeyOf;

    event AgentKeySet(uint256 indexed agentId, address indexed owner, address indexed key);

    error ZeroValidationRegistry();
    error ZeroIdentityRegistry();
    error NotAgentOwner(uint256 agentId, address caller);
    error NotAgentKey(uint256 agentId, address caller);
    error StaleAgentKey(uint256 agentId, address keyOwner, address currentOwner);

    constructor(address validationRegistry_) {
        if (validationRegistry_ == address(0)) revert ZeroValidationRegistry();
        address identityRegistry_ = IValidationRegistry(validationRegistry_).getIdentityRegistry();
        if (identityRegistry_ == address(0)) revert ZeroIdentityRegistry();
        validationRegistry = IValidationRegistry(validationRegistry_);
        identityRegistry = IIdentityRegistry(identityRegistry_);
    }

    /// @notice Sets the hot key that may request validations for `agentId`, or revokes it with
    /// `key = address(0)`. Only the agent's current owner may call it, not an operator.
    function setAgentKey(uint256 agentId, address key) external {
        address owner = identityRegistry.ownerOf(agentId);
        if (msg.sender != owner) revert NotAgentOwner(agentId, msg.sender);
        agentKeyOf[agentId] = AgentKey(key, owner);
        emit AgentKeySet(agentId, owner, key);
    }

    /// @notice Calls `validationRequest(validator, agentId, requestURI, requestHash)` on the
    /// ValidationRegistry as the agent's operator. Only the agent's key may call it, and only while
    /// the owner who set that key still owns the agent. The registry's own checks and reverts apply.
    function request(address validator, uint256 agentId, string calldata requestURI, bytes32 requestHash) external {
        AgentKey memory record = agentKeyOf[agentId];
        if (record.key == address(0) || msg.sender != record.key) revert NotAgentKey(agentId, msg.sender);
        address owner = identityRegistry.ownerOf(agentId);
        if (owner != record.owner) revert StaleAgentKey(agentId, record.owner, owner);
        validationRegistry.validationRequest(validator, agentId, requestURI, requestHash);
    }
}
