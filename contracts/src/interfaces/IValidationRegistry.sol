// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ERC-8004 Validation Registry interface
/// @notice Copied verbatim from the "Validation Registry" section of EIP-8004
/// (ethereum/ERCs commit 503591a, Draft). Differences between our
/// implementation and the EIP are logged in docs/spec-notes.md.
interface IValidationRegistry {
    event ValidationRequest(
        address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash
    );

    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    /// @notice MUST be called by the owner or an operator of `agentId` in the Identity Registry.
    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external;

    /// @notice MUST be called by the `validatorAddress` named in the request. `response` is 0-100.
    /// May be called several times for the same `requestHash`; the latest response is stored.
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;

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
        );

    /// @notice `agentId` is the only mandatory parameter; `validatorAddresses` and `tag` are optional filters.
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 averageResponse);

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory requestHashes);

    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory requestHashes);

    function getIdentityRegistry() external view returns (address identityRegistry);
}
