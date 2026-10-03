// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title MandateRegistry
/// @notice Per-agent spending mandate (SPEC §4.2): the targets and selectors an agent may act
/// through, a per-transaction and per-day MON value cap, and an expiry. `mandate-v1` reads this to
/// score an action, and the forwarder/gate flow never touches it directly.
/// @dev P4: the agent owner sets and revokes the mandate with a normal wallet transaction. Every
/// change — `setMandate` and `revokeMandate` — is routed through `_authorize(agentId, changeHash)`,
/// called before any write, which in P4 requires `msg.sender == identityRegistry.ownerOf(agentId)`.
/// P6 replaces `_authorize`'s body with a WebAuthn assertion verified via the P256 precompile at
/// `0x0100` (OpenZeppelin 5.7's `WebAuthn.WebAuthnAuth`), binding `changeHash` into the signed
/// challenge so a `setMandate` approval can't be replayed as a `revokeMandate` or vice versa. The
/// hook is internal, so P6 is a new, separate deployment rather than an upgrade.
/// Immutable, no admin, holds no funds.
contract MandateRegistry {
    struct Mandate {
        address[] allowedTargets;
        bytes4[] allowedSelectors;
        uint256 maxValuePerTx;
        uint256 maxValuePerDay;
        uint64 validUntil;
    }

    /// @dev The stored record for one agent: its mandate, the mandate's hash (so callers don't have
    /// to recompute it), the owner who set it (stale once the agent is transferred — Decision 7),
    /// and the block it was set at (Decision 8: a block number, so permission-change ordering can
    /// be compared with `(block, logIndex)`).
    struct Record {
        Mandate mandate;
        bytes32 mandateHash;
        address owner;
        uint64 setAtBlock;
    }

    uint256 public constant MAX_TARGETS = 16;
    uint256 public constant MAX_SELECTORS = 16;
    /// The `changeHash` that `revokeMandate` authorizes, distinct from any real `mandateHash`.
    bytes32 public constant REVOKE = keccak256("attest8004.MandateRegistry.revoke");

    IIdentityRegistry public immutable identityRegistry;

    /// @dev `internal` (not `private`) so the P6 override, and the test harness, can read the
    /// stored hash from inside `_authorize`, before this call's own write.
    mapping(uint256 agentId => Record) internal _records;

    event MandateSet(
        uint256 indexed agentId,
        bytes32 indexed mandateHash,
        address indexed owner,
        address[] allowedTargets,
        bytes4[] allowedSelectors,
        uint256 maxValuePerTx,
        uint256 maxValuePerDay,
        uint64 validUntil,
        uint64 setAtBlock
    );
    event MandateRevoked(uint256 indexed agentId, bytes32 indexed mandateHash, address indexed owner);

    error ZeroIdentityRegistry();
    error NotAgentOwner(uint256 agentId, address caller);
    error MandateAlreadyExpired(uint64 validUntil, uint256 timestamp);
    error TooManyTargets(uint256 count);
    error TooManySelectors(uint256 count);
    error ZeroTarget();
    error TxCapAboveDailyCap(uint256 maxValuePerTx, uint256 maxValuePerDay);
    error NoMandate(uint256 agentId);

    constructor(address identityRegistry_) {
        if (identityRegistry_ == address(0)) revert ZeroIdentityRegistry();
        identityRegistry = IIdentityRegistry(identityRegistry_);
    }

    /// @notice Sets (or replaces) `agentId`'s mandate. Only the agent's current owner may call it
    /// (via `_authorize`). Overwriting clears the previous `allowedTargets`/`allowedSelectors`
    /// arrays before storing the new ones.
    function setMandate(uint256 agentId, Mandate calldata mandate) external {
        bytes32 hash = mandateHashOf(mandate);
        address owner = _authorize(agentId, hash);
        _validate(mandate);

        Record storage record = _records[agentId];
        delete record.mandate.allowedTargets;
        delete record.mandate.allowedSelectors;
        for (uint256 i; i < mandate.allowedTargets.length; ++i) {
            record.mandate.allowedTargets.push(mandate.allowedTargets[i]);
        }
        for (uint256 i; i < mandate.allowedSelectors.length; ++i) {
            record.mandate.allowedSelectors.push(mandate.allowedSelectors[i]);
        }
        record.mandate.maxValuePerTx = mandate.maxValuePerTx;
        record.mandate.maxValuePerDay = mandate.maxValuePerDay;
        record.mandate.validUntil = mandate.validUntil;
        record.mandateHash = hash;
        record.owner = owner;
        // forge-lint: disable-next-line(unsafe-typecast) -- block numbers fit in uint64 for ~1e11 years at Monad's block rate
        uint64 setAtBlock = uint64(block.number);
        record.setAtBlock = setAtBlock;

        emit MandateSet(
            agentId,
            hash,
            owner,
            mandate.allowedTargets,
            mandate.allowedSelectors,
            mandate.maxValuePerTx,
            mandate.maxValuePerDay,
            mandate.validUntil,
            setAtBlock
        );
    }

    /// @notice Clears `agentId`'s mandate. Only the agent's current owner may call it (via
    /// `_authorize`). Reverts `NoMandate` if none is set.
    function revokeMandate(uint256 agentId) external {
        address owner = _authorize(agentId, REVOKE);

        Record storage record = _records[agentId];
        bytes32 oldHash = record.mandateHash;
        if (oldHash == bytes32(0)) revert NoMandate(agentId);

        delete _records[agentId];
        emit MandateRevoked(agentId, oldHash, owner);
    }

    /// @notice Returns `agentId`'s mandate, its hash, the owner who set it and the block it was
    /// set at. All zero/empty if no mandate has ever been set (or it was revoked).
    function getMandate(uint256 agentId)
        external
        view
        returns (Mandate memory mandate, bytes32 mandateHash, address owner, uint64 setAtBlock)
    {
        Record storage record = _records[agentId];
        return (record.mandate, record.mandateHash, record.owner, record.setAtBlock);
    }

    /// @notice The hash that identifies a `Mandate`'s contents, binding every field.
    function mandateHashOf(Mandate calldata mandate) public pure returns (bytes32) {
        return keccak256(abi.encode(mandate));
    }

    /// @notice Authorizes a change to `agentId`'s mandate and returns the owner of record. P4:
    /// `msg.sender` must be `identityRegistry.ownerOf(agentId)` (an operator or approved address is
    /// not enough — Decision 7, the forwarder's `AgentKey.owner` pattern). P6 overrides this to
    /// verify a WebAuthn assertion over `changeHash` instead.
    /// @dev Called before any state write in `setMandate`/`revokeMandate`, so an override — P6's or
    /// a reverting test hook — can veto the change entirely.
    function _authorize(uint256 agentId, bytes32 changeHash) internal virtual returns (address owner) {
        changeHash; // unused in P4; a WebAuthn override binds it into the signed challenge.
        owner = identityRegistry.ownerOf(agentId);
        if (msg.sender != owner) revert NotAgentOwner(agentId, msg.sender);
    }

    /// @dev Decision 7: a zero target, more than 16 targets/selectors, an already-expired
    /// `validUntil`, or a per-tx cap above the per-day cap, all revert. Equal caps and
    /// `validUntil == block.timestamp + 1` are valid.
    function _validate(Mandate calldata mandate) private view {
        // forge-lint: disable-next-line(block-timestamp) -- validUntil is in seconds; a few seconds of validator skew is harmless
        if (mandate.validUntil <= block.timestamp) {
            revert MandateAlreadyExpired(mandate.validUntil, block.timestamp);
        }
        if (mandate.allowedTargets.length > MAX_TARGETS) revert TooManyTargets(mandate.allowedTargets.length);
        if (mandate.allowedSelectors.length > MAX_SELECTORS) {
            revert TooManySelectors(mandate.allowedSelectors.length);
        }
        // forge-lint: disable-next-item(require-revert-in-loop) -- bounded by MAX_TARGETS (16); one bad target must reject the mandate
        for (uint256 i; i < mandate.allowedTargets.length; ++i) {
            if (mandate.allowedTargets[i] == address(0)) revert ZeroTarget();
        }
        if (mandate.maxValuePerTx > mandate.maxValuePerDay) {
            revert TxCapAboveDailyCap(mandate.maxValuePerTx, mandate.maxValuePerDay);
        }
    }
}
