// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IValidationRegistry} from "./interfaces/IValidationRegistry.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title Attest8004 ValidationRegistry
/// @notice The ERC-8004 Validation Registry (EIP-8004, "Validation Registry" section). An agent's
/// owner or operator asks a validator to check a request; the validator posts a 0-100 response
/// that any contract or app can read.
/// @dev Spec-conformant but not canonical. Behaviour matches the reference implementation
/// (erc-8004/erc-8004-contracts `ValidationRegistryUpgradeable` v2.0.0) except that this contract
/// is immutable: the Identity Registry is a constructor argument, and there is no owner, proxy or
/// upgrade path. Every difference from the EIP and the reference is listed in docs/spec-notes.md.
contract ValidationRegistry is IValidationRegistry {
    struct Validation {
        // Slot 0: validatorAddress (20) + response (1) + hasResponse (1) + lastUpdate (8).
        address validatorAddress;
        uint8 response;
        // The EIP read interface can't tell "pending" from "responded 0"; this flag keeps
        // pending requests out of getSummary, as in the reference implementation.
        bool hasResponse;
        uint64 lastUpdate;
        uint256 agentId;
        bytes32 responseHash;
        string tag;
    }

    IIdentityRegistry private immutable _identityRegistry;

    mapping(bytes32 requestHash => Validation) private _validations;
    mapping(uint256 agentId => bytes32[]) private _agentValidations;
    mapping(address validatorAddress => bytes32[]) private _validatorRequests;

    error ZeroIdentityRegistry();
    error ZeroValidator();
    error RequestExists(bytes32 requestHash);
    error NotAgentOwnerOrOperator(uint256 agentId, address caller);
    error UnknownRequest(bytes32 requestHash);
    error NotRequestedValidator(bytes32 requestHash, address caller);
    error ResponseOutOfRange(uint8 response);

    /// @param identityRegistry_ The ERC-8004 Identity Registry that decides who owns or operates
    /// an agent. It replaces the EIP's `initialize(address)` (docs/spec-notes.md, row 1).
    constructor(address identityRegistry_) {
        if (identityRegistry_ == address(0)) revert ZeroIdentityRegistry();
        _identityRegistry = IIdentityRegistry(identityRegistry_);
    }

    /// @inheritdoc IValidationRegistry
    /// @dev `requestHash` identifies the request globally, so each hash names exactly one
    /// validator; reusing a hash reverts, whichever validator it names (spec-notes, row 5).
    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external {
        if (validatorAddress == address(0)) revert ZeroValidator();
        if (_validations[requestHash].validatorAddress != address(0)) revert RequestExists(requestHash);
        if (!_isOwnerOrOperator(agentId, msg.sender)) revert NotAgentOwnerOrOperator(agentId, msg.sender);

        Validation storage v = _validations[requestHash];
        v.validatorAddress = validatorAddress;
        // forge-lint: disable-next-line(unsafe-typecast) -- timestamps fit in uint64 for ~5e11 years
        v.lastUpdate = uint64(block.timestamp);
        v.agentId = agentId;

        _agentValidations[agentId].push(requestHash);
        _validatorRequests[validatorAddress].push(requestHash);

        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    /// @inheritdoc IValidationRegistry
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        Validation storage v = _validations[requestHash];
        address validatorAddress = v.validatorAddress;
        if (validatorAddress == address(0)) revert UnknownRequest(requestHash);
        if (msg.sender != validatorAddress) revert NotRequestedValidator(requestHash, msg.sender);
        if (response > 100) revert ResponseOutOfRange(response);

        v.response = response;
        v.hasResponse = true;
        // forge-lint: disable-next-line(unsafe-typecast) -- timestamps fit in uint64 for ~5e11 years
        v.lastUpdate = uint64(block.timestamp);
        v.responseHash = responseHash;
        v.tag = tag;

        emit ValidationResponse(validatorAddress, v.agentId, requestHash, response, responseURI, responseHash, tag);
    }

    /// @inheritdoc IValidationRegistry
    /// @dev Reverts for an unknown hash. A pending request reads as response 0 with an empty tag
    /// and `lastUpdate` = request time, so consumers must require a score of at least 1.
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        )
    {
        Validation storage v = _validations[requestHash];
        if (v.validatorAddress == address(0)) revert UnknownRequest(requestHash);
        return (v.validatorAddress, v.agentId, v.response, v.responseHash, v.tag, v.lastUpdate);
    }

    /// @inheritdoc IValidationRegistry
    /// @dev Counts requests that have a response, using each request's latest response. An empty
    /// `validatorAddresses` or `tag` means no filter. The average is floored; (0, 0) if none match.
    /// Loops over every request of the agent: meant for offchain reads.
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 averageResponse)
    {
        bytes32[] storage requestHashes = _agentValidations[agentId];
        bool filterTag = bytes(tag).length != 0;
        bytes32 tagHash = keccak256(bytes(tag));
        uint256 total = 0;

        for (uint256 i; i < requestHashes.length; ++i) {
            Validation storage v = _validations[requestHashes[i]];
            if (!v.hasResponse) continue;
            if (validatorAddresses.length != 0 && !_contains(validatorAddresses, v.validatorAddress)) continue;
            if (filterTag && keccak256(bytes(v.tag)) != tagHash) continue;
            total += v.response;
            ++count;
        }

        // forge-lint: disable-next-line(unsafe-typecast) -- every response is <= 100, so the average is too
        if (count != 0) averageResponse = uint8(total / count);
    }

    /// @inheritdoc IValidationRegistry
    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory requestHashes) {
        return _agentValidations[agentId];
    }

    /// @inheritdoc IValidationRegistry
    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory requestHashes) {
        return _validatorRequests[validatorAddress];
    }

    /// @inheritdoc IValidationRegistry
    function getIdentityRegistry() external view returns (address identityRegistry) {
        return address(_identityRegistry);
    }

    /// @dev EIP-8004: "MUST be called by the owner or operator of agentId". Operators are the
    /// ERC-721 ones: approved for all of the owner's tokens, or approved for this token.
    /// `ownerOf` reverts for an agent that doesn't exist.
    function _isOwnerOrOperator(uint256 agentId, address caller) private view returns (bool) {
        address owner = _identityRegistry.ownerOf(agentId);
        return caller == owner || _identityRegistry.isApprovedForAll(owner, caller)
            || _identityRegistry.getApproved(agentId) == caller;
    }

    function _contains(address[] calldata list, address value) private pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == value) return true;
        }
        return false;
    }
}
