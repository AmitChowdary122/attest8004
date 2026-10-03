// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {MandateRegistry} from "../../src/MandateRegistry.sol";

/// @notice Proves that every mandate change goes through `_authorize` before any state write
/// (P6 will replace `_authorize`'s body with WebAuthn verification, so this ordering must hold
/// regardless of what the hook does). It records each call's arguments and a snapshot of the
/// agent's stored `mandateHash` taken from *inside* `_authorize`, before this call's own write — if
/// `_authorize` ran after the write instead, that snapshot would already show the new hash, not the
/// old one. It can also be told to revert, to prove a vetoed change leaves storage untouched.
contract MandateRegistryHookHarness is MandateRegistry {
    bool public shouldRevert;
    uint256 public authorizeCalls;
    uint256 public lastAgentId;
    bytes32 public lastChangeHash;
    /// `_records[agentId].mandateHash` as read from inside `_authorize`, i.e. before this call's
    /// own write (still the *previous* hash, or zero if none was ever set).
    bytes32 public mandateHashBeforeWrite;

    constructor(address identityRegistry_) MandateRegistry(identityRegistry_) {}

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function _authorize(uint256 agentId, bytes32 changeHash) internal override returns (address owner) {
        ++authorizeCalls;
        lastAgentId = agentId;
        lastChangeHash = changeHash;
        mandateHashBeforeWrite = _records[agentId].mandateHash;
        if (shouldRevert) revert("MandateRegistryHookHarness: reverted");
        return super._authorize(agentId, changeHash);
    }
}
