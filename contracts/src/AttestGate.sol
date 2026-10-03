// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IValidationRegistry} from "./interfaces/IValidationRegistry.sol";
import {Action, ActionHash} from "./ActionHash.sol";

/// @title AttestGate
/// @notice Lets a contract refuse an agent's action unless every validator it requires has judged
/// exactly that action, scored it at least that validator's minimum, and tagged its verdict with
/// that requirement's own tag (SPEC §4.3).
/// @dev For each requirement, the gate recomputes that validator's `requestHash` from the call
/// (ActionHash: this chain, this gate, the exact action) and reads the ERC-8004 ValidationRegistry.
/// It checks the stored validator and agentId as well as the score, because anyone who owns an
/// agent can claim a `requestHash` first (docs/spec-notes.md, row 12). `requestHash` already binds
/// one validator to one exact action, but not to any particular check that validator ran for it, so
/// the gate also checks that the stored tag hashes to the requirement's `tagHash`: a verdict from
/// some other check that same validator happens to run for this action doesn't satisfy it. It then
/// marks the validator-independent `actionHash` consumed, so an action runs at most once, before the
/// consumer makes any external call. Consumers should also make the gated function
/// `nonReentrant`. The requirement list is fixed at deployment: there is no owner.
abstract contract AttestGate is ReentrancyGuardTransient {
    struct Requirement {
        address validator;
        /// 1-100. A pending request reads as response 0, so 0 is rejected.
        uint8 minScore;
        /// keccak256 of the tag that validator's verdict for this action must carry (e.g.
        /// keccak256("mandate-v1")), so a verdict from some other check that same validator
        /// happens to run for this action doesn't satisfy this requirement. Never zero: no real
        /// tag hashes to the zero value, so a zero tagHash would be a requirement nothing could
        /// ever satisfy, locking the gate shut.
        bytes32 tagHash;
    }

    uint256 public constant MAX_REQUIREMENTS = 4;

    IValidationRegistry public immutable validationRegistry;

    // Solidity has no immutable arrays, so the requirements are packed into immutables:
    // uint160(validator) | uint256(minScore) << 160. That also spares a cold SLOAD per
    // requirement on every execute (8,100 gas each on Monad). tagHash is a full bytes32, so it
    // gets its own immutable per slot rather than sharing the packed word.
    uint256 private immutable _requirementCount;
    uint256 private immutable _requirement0;
    uint256 private immutable _requirement1;
    uint256 private immutable _requirement2;
    uint256 private immutable _requirement3;
    bytes32 private immutable _tagHash0;
    bytes32 private immutable _tagHash1;
    bytes32 private immutable _tagHash2;
    bytes32 private immutable _tagHash3;

    mapping(bytes32 actionHash => bool) public consumed;

    event ActionConsumed(bytes32 indexed actionHash, uint256 indexed agentId);

    error ZeroValidationRegistry();
    error NoRequirements();
    error TooManyRequirements(uint256 count, uint256 max);
    error ZeroValidator();
    error InvalidMinScore(address validator, uint8 minScore);
    error DuplicateValidator(address validator);
    error ZeroTagHash(address validator);
    error ActionExpired(uint64 deadline, uint256 timestamp);
    error ActionAlreadyConsumed(bytes32 actionHash);
    error ValidationNotFound(address validator, bytes32 requestHash);
    error ValidatorMismatch(bytes32 requestHash, address expected, address actual);
    error AgentMismatch(bytes32 requestHash, uint256 expected, uint256 actual);
    error ScoreTooLow(address validator, bytes32 requestHash, uint8 response, uint8 minScore);
    error TagMismatch(address validator, bytes32 requestHash, bytes32 expected, bytes32 actual);

    /// @param validationRegistry_ The ERC-8004 ValidationRegistry the verdicts are read from.
    /// @param requirements_ 1 to 4 distinct validators, each with a minimum score of 1-100 and a
    /// non-zero tagHash. Every one must pass for an action to execute.
    // forge-lint: disable-next-item(require-revert-in-loop) -- one bad requirement must reject the deployment
    constructor(address validationRegistry_, Requirement[] memory requirements_) {
        if (validationRegistry_ == address(0)) revert ZeroValidationRegistry();
        uint256 count = requirements_.length;
        if (count == 0) revert NoRequirements();
        if (count > MAX_REQUIREMENTS) revert TooManyRequirements(count, MAX_REQUIREMENTS);
        for (uint256 i; i < count; ++i) {
            Requirement memory r = requirements_[i];
            if (r.validator == address(0)) revert ZeroValidator();
            if (r.minScore == 0 || r.minScore > 100) revert InvalidMinScore(r.validator, r.minScore);
            if (r.tagHash == bytes32(0)) revert ZeroTagHash(r.validator);
            for (uint256 j; j < i; ++j) {
                if (requirements_[j].validator == r.validator) revert DuplicateValidator(r.validator);
            }
        }

        validationRegistry = IValidationRegistry(validationRegistry_);
        _requirementCount = count;
        _requirement0 = _pack(requirements_[0]);
        _requirement1 = count > 1 ? _pack(requirements_[1]) : 0;
        _requirement2 = count > 2 ? _pack(requirements_[2]) : 0;
        _requirement3 = count > 3 ? _pack(requirements_[3]) : 0;
        _tagHash0 = requirements_[0].tagHash;
        _tagHash1 = count > 1 ? requirements_[1].tagHash : bytes32(0);
        _tagHash2 = count > 2 ? requirements_[2].tagHash : bytes32(0);
        _tagHash3 = count > 3 ? requirements_[3].tagHash : bytes32(0);
    }

    /// @notice Reverts unless `action` is unexpired, unused, and passed by every required
    /// validator; then marks it consumed. Runs before the function body.
    modifier onlyValidated(Action calldata action) {
        _consumeValidation(action);
        _;
    }

    /// @notice The validators this gate requires, in check order, with their minimum scores and
    /// required tag hashes.
    function requirements() external view returns (Requirement[] memory list) {
        list = new Requirement[](_requirementCount);
        for (uint256 i; i < list.length; ++i) {
            (list[i].validator, list[i].minScore, list[i].tagHash) = _requirementAt(i);
        }
    }

    /// @notice The hash this gate marks consumed for `action` (ActionHash.actionHash).
    function actionHashOf(Action calldata action) public view returns (bytes32) {
        return ActionHash.actionHash(action, block.chainid, address(this));
    }

    /// @notice The ERC-8004 `requestHash` an agent must submit to `validator` for `action` at
    /// this gate (ActionHash.requestHash).
    function requestHashOf(Action calldata action, address validator) public view returns (bytes32) {
        return ActionHash.requestHash(action, block.chainid, address(this), validator);
    }

    /// @dev Checks in order: deadline, not consumed, then each requirement (request found, named
    /// validator, agentId, score, tag). Marks the action consumed only if all pass.
    function _consumeValidation(Action calldata action) internal returns (bytes32 actionHash) {
        // forge-lint: disable-next-line(block-timestamp) -- deadlines are in seconds; a few seconds of skew is harmless
        if (block.timestamp > action.deadline) revert ActionExpired(action.deadline, block.timestamp);
        actionHash = actionHashOf(action);
        if (consumed[actionHash]) revert ActionAlreadyConsumed(actionHash);

        uint256 count = _requirementCount;
        for (uint256 i; i < count; ++i) {
            (address validator, uint8 minScore, bytes32 tagHash) = _requirementAt(i);
            _checkVerdict(action, validator, minScore, tagHash);
        }

        consumed[actionHash] = true;
        emit ActionConsumed(actionHash, action.agentId);
    }

    // Called once per requirement (at most 4 view calls to the fixed registry); any failure must revert.
    // forge-lint: disable-next-item(calls-loop,require-revert-in-loop)
    function _checkVerdict(Action calldata action, address validator, uint8 minScore, bytes32 tagHash) private view {
        bytes32 requestHash = requestHashOf(action, validator);
        // The registry reverts for an unknown requestHash. Any failure of this read fails closed.
        try validationRegistry.getValidationStatus(requestHash) returns (
            address storedValidator, uint256 storedAgentId, uint8 response, bytes32, string memory tag, uint256
        ) {
            if (storedValidator != validator) revert ValidatorMismatch(requestHash, validator, storedValidator);
            if (storedAgentId != action.agentId) revert AgentMismatch(requestHash, action.agentId, storedAgentId);
            if (response < minScore) revert ScoreTooLow(validator, requestHash, response, minScore);
            bytes32 actualTagHash = keccak256(bytes(tag));
            if (actualTagHash != tagHash) revert TagMismatch(validator, requestHash, tagHash, actualTagHash);
        } catch {
            revert ValidationNotFound(validator, requestHash);
        }
    }

    function _requirementAt(uint256 i) private view returns (address validator, uint8 minScore, bytes32 tagHash) {
        uint256 packed = i == 0 ? _requirement0 : i == 1 ? _requirement1 : i == 2 ? _requirement2 : _requirement3;
        // forge-lint: disable-next-line(unsafe-typecast) -- the low 160 bits hold the validator
        validator = address(uint160(packed));
        // forge-lint: disable-next-line(unsafe-typecast) -- bits 160-167 hold the uint8 minScore
        minScore = uint8(packed >> 160);
        tagHash = i == 0 ? _tagHash0 : i == 1 ? _tagHash1 : i == 2 ? _tagHash2 : _tagHash3;
    }

    function _pack(Requirement memory r) private pure returns (uint256) {
        return uint256(uint160(r.validator)) | (uint256(r.minScore) << 160);
    }
}
