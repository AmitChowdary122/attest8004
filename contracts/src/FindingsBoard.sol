// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title FindingsBoard
/// @notice Carries validators' encrypted operator reports (SPEC §4.7): each post is one event, with
/// the poster as its `validator`. The board stores nothing and judges nothing. Anyone can post, so a
/// reader trusts a post only when `ValidationRegistry.getValidationStatus(requestHash)` names that
/// same validator and agent; every other post is ignored. A validator's public plaintext evidence
/// stays at its `responseURI`; the envelope here is ciphertext for the agent's inbox key.
/// @dev Immutable, no admin, no storage, no constructor arguments, holds no funds. The envelope's
/// format (version, ephemeral X25519 key, nonce, AES-256-GCM ciphertext) is the readers' concern; the
/// board only caps its size.
contract FindingsBoard {
    /// The largest envelope a post may carry, in bytes.
    uint256 public constant MAX_ENVELOPE_BYTES = 8192;

    event FindingsPosted(
        bytes32 indexed requestHash, uint256 indexed agentId, address indexed validator, bytes envelope
    );

    error EnvelopeTooLarge(uint256 length, uint256 max);

    /// @notice Posts an encrypted report for `requestHash` and `agentId`, as `msg.sender`.
    function post(bytes32 requestHash, uint256 agentId, bytes calldata envelope) external {
        if (envelope.length > MAX_ENVELOPE_BYTES) revert EnvelopeTooLarge(envelope.length, MAX_ENVELOPE_BYTES);
        emit FindingsPosted(requestHash, agentId, msg.sender, envelope);
    }
}
