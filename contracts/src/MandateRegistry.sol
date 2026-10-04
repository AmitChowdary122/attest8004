// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title MandateRegistry
/// @notice Per-agent spending mandate (SPEC §4.2): the targets and selectors an agent may act
/// through, a per-transaction and per-day MON value cap, and an expiry. `mandate-v1` reads this to
/// score an action, and the forwarder/gate flow never touches it directly.
/// @dev v2 (P6): every change to a mandate, the passkey or the inbox key needs **two factors** —
/// a transaction from the agent's current owner (`identityRegistry.ownerOf`) and a WebAuthn
/// assertion from the passkey bound to the agent, verified with OpenZeppelin 5.7's `WebAuthn`
/// (UP and UV required, low-s, through the P256 precompile at `0x0100`).
/// - **The challenge** the passkey signs is `challengeFor(agentId, changeHash, nonce)` =
///   `sha256(abi.encode(block.chainid, address(this), agentId, changeHash, nonce))`, so an approval
///   is good for one chain, this registry, one agent, one change and one use. `changeHash` is the
///   `mandateHash` for `setMandate`, and a tagged hash for `rotatePasskey` and `setInboxKey`, so an
///   approval for one operation can't be replayed as another.
/// - **The rpId binding:** `authenticatorData` must start with `rpIdHash`, set at deployment
///   (`sha256("attest8004.vercel.app")`). OpenZeppelin doesn't check it, so we do.
/// - **The passkey is bound to the agent**, not to its owner: the owner sets it once
///   (`setPasskey`), it survives a transfer, and only the current owner together with the current
///   passkey can rotate it. Sell an agent only after rotating to the buyer's passkey.
/// - **Revoke is the panic button:** `revokeMandate` needs the owner only, no passkey, and also
///   bumps the nonce, which cancels every approval that is signed but not yet submitted (while a
///   mandate is set: with none set it reverts `NoMandate`, and a pending approval can only set the
///   mandate its passkey signed).
/// - **No recovery:** a lost passkey locks the agent's mandate, passkey and inbox key changes
///   (revoke still works). A timelocked owner reset is on the roadmap.
/// Every passkey-approved change goes through `_authorize` before any write. Immutable, no admin,
/// holds no funds.
contract MandateRegistry {
    struct Mandate {
        address[] allowedTargets;
        bytes4[] allowedSelectors;
        uint256 maxValuePerTx;
        uint256 maxValuePerDay;
        uint64 validUntil;
    }

    /// @dev The stored record for one agent: its mandate, the mandate's hash (so callers don't have
    /// to recompute it), the owner who set it (stale once the agent is transferred), and the block
    /// it was set at (a block number, so permission-change ordering can be compared with
    /// `(block, logIndex)`).
    struct Record {
        Mandate mandate;
        bytes32 mandateHash;
        address owner;
        uint64 setAtBlock;
    }

    /// @dev A P-256 public key. `(0, 0)` is not on the curve, so it means "no passkey".
    struct Passkey {
        bytes32 qx;
        bytes32 qy;
    }

    uint256 public constant MAX_TARGETS = 16;
    uint256 public constant MAX_SELECTORS = 16;
    /// Tags for the `changeHash` of `rotatePasskey` and `setInboxKey`.
    bytes32 public constant ROTATE_PASSKEY = keccak256("attest8004.MandateRegistry.rotatePasskey");
    bytes32 public constant SET_INBOX_KEY = keccak256("attest8004.MandateRegistry.setInboxKey");

    IIdentityRegistry public immutable identityRegistry;
    /// sha256 of the WebAuthn relying party ID; every assertion's `authenticatorData` starts with it.
    bytes32 public immutable rpIdHash;

    /// @dev `internal` (not `private`) so the test harness can read the stored state from inside
    /// `_authorize`, before this call's own writes.
    mapping(uint256 agentId => Record) internal _records;
    mapping(uint256 agentId => Passkey) internal _passkeys;
    mapping(uint256 agentId => uint256) internal _nonces;
    mapping(uint256 agentId => bytes32) internal _inboxKeys;

    event PasskeySet(uint256 indexed agentId, address indexed owner, bytes32 qx, bytes32 qy);
    event PasskeyRotated(
        uint256 indexed agentId, address indexed owner, bytes32 oldQx, bytes32 oldQy, bytes32 qx, bytes32 qy
    );
    event InboxKeySet(uint256 indexed agentId, address indexed owner, bytes32 x25519Pub);
    /// @dev Same signature (and topic0) as P4's, so one ABI decodes both registries.
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
    /// @dev Same signature (and topic0) as P4's.
    event MandateRevoked(uint256 indexed agentId, bytes32 indexed mandateHash, address indexed owner);

    error ZeroIdentityRegistry();
    error ZeroRpIdHash();
    error NotAgentOwner(uint256 agentId, address caller);
    error NoPasskey(uint256 agentId);
    error PasskeyAlreadySet(uint256 agentId);
    error InvalidPasskey(bytes32 qx, bytes32 qy);
    error WrongRpIdHash(bytes32 expected, bytes32 actual);
    error InvalidAssertion(uint256 agentId);
    error ZeroInboxKey();
    error MandateAlreadyExpired(uint64 validUntil, uint256 timestamp);
    error TooManyTargets(uint256 count);
    error TooManySelectors(uint256 count);
    error ZeroTarget();
    error TxCapAboveDailyCap(uint256 maxValuePerTx, uint256 maxValuePerDay);
    error NoMandate(uint256 agentId);

    constructor(address identityRegistry_, bytes32 rpIdHash_) {
        if (identityRegistry_ == address(0)) revert ZeroIdentityRegistry();
        if (rpIdHash_ == bytes32(0)) revert ZeroRpIdHash();
        identityRegistry = IIdentityRegistry(identityRegistry_);
        rpIdHash = rpIdHash_;
    }

    /// @notice Binds a passkey to `agentId`, once. Owner only; the key must be on the P-256 curve.
    /// There is no onchain proof of possession: a key nobody can sign with locks every later change
    /// except `revokeMandate`.
    function setPasskey(uint256 agentId, bytes32 qx, bytes32 qy) external {
        address owner = _requireOwner(agentId);
        if (_hasPasskey(agentId)) revert PasskeyAlreadySet(agentId);
        if (!P256.isValidPublicKey(qx, qy)) revert InvalidPasskey(qx, qy);

        _passkeys[agentId] = Passkey(qx, qy);
        // forge-lint: disable-next-line(reentrancy-events) -- the "external call" is OpenZeppelin's internal P256/WebAuthn library (a jump that only STATICCALLs precompiles)
        emit PasskeySet(agentId, owner, qx, qy);
    }

    /// @notice Replaces `agentId`'s passkey with `(qx, qy)`. Needs the owner and an assertion from
    /// the *current* passkey over `keccak256(abi.encode(ROTATE_PASSKEY, qx, qy))`.
    function rotatePasskey(uint256 agentId, bytes32 qx, bytes32 qy, WebAuthn.WebAuthnAuth calldata auth) external {
        address owner = _authorize(agentId, keccak256(abi.encode(ROTATE_PASSKEY, qx, qy)), auth);
        if (!P256.isValidPublicKey(qx, qy)) revert InvalidPasskey(qx, qy);

        Passkey storage key = _passkeys[agentId];
        (bytes32 oldQx, bytes32 oldQy) = (key.qx, key.qy);
        (key.qx, key.qy) = (qx, qy);
        // forge-lint: disable-next-line(reentrancy-events) -- the "external call" is OpenZeppelin's internal P256/WebAuthn library (a jump that only STATICCALLs precompiles)
        emit PasskeyRotated(agentId, owner, oldQx, oldQy, qx, qy);
    }

    /// @notice Sets (or replaces) `agentId`'s mandate. Needs the owner and a passkey assertion over
    /// the mandate's hash, so `MandateSet.mandateHash` is exactly what the passkey approved.
    /// Overwriting clears the previous `allowedTargets`/`allowedSelectors` arrays before storing
    /// the new ones.
    function setMandate(uint256 agentId, Mandate calldata mandate, WebAuthn.WebAuthnAuth calldata auth) external {
        bytes32 hash = mandateHashOf(mandate);
        address owner = _authorize(agentId, hash, auth);
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

        // forge-lint: disable-next-item(reentrancy-events) -- the "external call" is OpenZeppelin's internal P256/WebAuthn library (a jump that only STATICCALLs precompiles)
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

    /// @notice Clears `agentId`'s mandate: the panic button. Owner only, no passkey, since it can
    /// only take permissions away. It also bumps the nonce, cancelling every approval that is
    /// signed but not yet submitted. Reverts `NoMandate` if none is set.
    function revokeMandate(uint256 agentId) external {
        address owner = _requireOwner(agentId);
        bytes32 oldHash = _records[agentId].mandateHash;
        if (oldHash == bytes32(0)) revert NoMandate(agentId);

        delete _records[agentId];
        ++_nonces[agentId];
        emit MandateRevoked(agentId, oldHash, owner);
    }

    /// @notice Sets `agentId`'s X25519 inbox public key. Needs the owner and a passkey assertion
    /// over `keccak256(abi.encode(SET_INBOX_KEY, x25519Pub))`. Zero (a low-order point) reverts.
    function setInboxKey(uint256 agentId, bytes32 x25519Pub, WebAuthn.WebAuthnAuth calldata auth) external {
        address owner = _authorize(agentId, keccak256(abi.encode(SET_INBOX_KEY, x25519Pub)), auth);
        if (x25519Pub == bytes32(0)) revert ZeroInboxKey();

        _inboxKeys[agentId] = x25519Pub;
        // forge-lint: disable-next-line(reentrancy-events) -- the "external call" is OpenZeppelin's internal P256/WebAuthn library (a jump that only STATICCALLs precompiles)
        emit InboxKeySet(agentId, owner, x25519Pub);
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

    /// @notice `agentId`'s passkey, `(0, 0)` if none is set.
    function passkeyOf(uint256 agentId) external view returns (bytes32 qx, bytes32 qy) {
        Passkey storage key = _passkeys[agentId];
        return (key.qx, key.qy);
    }

    /// @notice The nonce the next passkey approval for `agentId` must be signed at.
    function nonceOf(uint256 agentId) external view returns (uint256) {
        return _nonces[agentId];
    }

    /// @notice `agentId`'s X25519 inbox public key, zero if none is set.
    function inboxKeyOf(uint256 agentId) external view returns (bytes32) {
        return _inboxKeys[agentId];
    }

    /// @notice The hash that identifies a `Mandate`'s contents, binding every field.
    function mandateHashOf(Mandate calldata mandate) public pure returns (bytes32) {
        return keccak256(abi.encode(mandate));
    }

    /// @notice The WebAuthn challenge (its 32 raw bytes) a passkey signs to approve `changeHash`
    /// for `agentId` at `nonce`, on this chain and this registry.
    function challengeFor(uint256 agentId, bytes32 changeHash, uint256 nonce) public view returns (bytes32) {
        return sha256(abi.encode(block.chainid, address(this), agentId, changeHash, nonce));
    }

    /// @notice Authorizes a passkey-approved change and returns the owner of record. In order:
    /// `msg.sender` is `identityRegistry.ownerOf(agentId)` (an operator or approved address is not
    /// enough); a passkey is set; `authenticatorData` is at least 37 bytes and starts with
    /// `rpIdHash`; the assertion verifies (OpenZeppelin `WebAuthn.verify`, UV required) over
    /// `challengeFor(agentId, changeHash, nonce)`. Then the nonce is incremented — only on success.
    /// @dev Called before any state write in `setMandate`, `rotatePasskey` and `setInboxKey`, so
    /// an override (a reverting test hook) can veto the change entirely.
    function _authorize(uint256 agentId, bytes32 changeHash, WebAuthn.WebAuthnAuth calldata auth)
        internal
        virtual
        returns (address owner)
    {
        owner = _requireOwner(agentId);
        Passkey storage key = _passkeys[agentId];
        (bytes32 qx, bytes32 qy) = (key.qx, key.qy);
        if (qx == bytes32(0) && qy == bytes32(0)) revert NoPasskey(agentId);

        if (auth.authenticatorData.length < 37) revert InvalidAssertion(agentId);
        bytes32 actualRpIdHash = bytes32(auth.authenticatorData[:32]);
        if (actualRpIdHash != rpIdHash) revert WrongRpIdHash(rpIdHash, actualRpIdHash);

        uint256 nonce = _nonces[agentId];
        // OpenZeppelin reads 32 bytes of memory at `typeIndex` before comparing it with the JSON's
        // length, so a huge index would be an out-of-gas rather than `false`; an index past the JSON
        // is never valid. (`challengeIndex` goes through a clamped slice, so it needs no guard.)
        if (
            auth.typeIndex >= bytes(auth.clientDataJSON).length
                || !WebAuthn.verify(abi.encodePacked(challengeFor(agentId, changeHash, nonce)), auth, qx, qy, true)
        ) {
            revert InvalidAssertion(agentId);
        }
        _nonces[agentId] = nonce + 1;
    }

    function _requireOwner(uint256 agentId) private view returns (address owner) {
        owner = identityRegistry.ownerOf(agentId);
        if (msg.sender != owner) revert NotAgentOwner(agentId, msg.sender);
    }

    function _hasPasskey(uint256 agentId) private view returns (bool) {
        Passkey storage key = _passkeys[agentId];
        return key.qx != bytes32(0) || key.qy != bytes32(0);
    }

    /// @dev A zero target, more than 16 targets/selectors, an already-expired `validUntil`, or a
    /// per-tx cap above the per-day cap, all revert. Equal caps and `validUntil == block.timestamp +
    /// 1` are valid.
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
