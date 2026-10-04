// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";

/// @notice Proves that every passkey-approved change (`setMandate`, `rotatePasskey`,
/// `setInboxKey`) goes through `_authorize` before any state write. It records each call's
/// arguments and a snapshot of the agent's stored state — mandate hash, passkey, inbox key and
/// nonce — taken from *inside* `_authorize`, before this call's own writes: if `_authorize` ran
/// after a write, the snapshot would already show the new value, not the old one. It can also be
/// told to revert, to prove a vetoed change leaves storage untouched.
contract MandateRegistryHookHarness is MandateRegistry {
    bool public shouldRevert;
    uint256 public authorizeCalls;
    uint256 public lastAgentId;
    bytes32 public lastChangeHash;
    /// The agent's stored state as read from inside `_authorize`, before this call's own writes.
    bytes32 public mandateHashBeforeWrite;
    bytes32 public passkeyQxBeforeWrite;
    bytes32 public passkeyQyBeforeWrite;
    bytes32 public inboxKeyBeforeWrite;
    uint256 public nonceBeforeWrite;

    constructor(address identityRegistry_, bytes32 rpIdHash_) MandateRegistry(identityRegistry_, rpIdHash_) {}

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function _authorize(uint256 agentId, bytes32 changeHash, WebAuthn.WebAuthnAuth calldata auth)
        internal
        override
        returns (address owner)
    {
        ++authorizeCalls;
        lastAgentId = agentId;
        lastChangeHash = changeHash;
        mandateHashBeforeWrite = _records[agentId].mandateHash;
        passkeyQxBeforeWrite = _passkeys[agentId].qx;
        passkeyQyBeforeWrite = _passkeys[agentId].qy;
        inboxKeyBeforeWrite = _inboxKeys[agentId];
        nonceBeforeWrite = _nonces[agentId];
        if (shouldRevert) revert("MandateRegistryHookHarness: reverted");
        return super._authorize(agentId, changeHash, auth);
    }
}
