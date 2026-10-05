// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IReceiver} from "./interfaces/IReceiver.sol";
import {IValidationRegistry} from "./interfaces/IValidationRegistry.sol";

/// @title CreValidator (validator C)
/// @notice The address of validator C: a Chainlink CRE workflow's receiver. The workflow runs the
/// deterministic mandate-v1 check and delivers its verdict through a Keystone forwarder; this
/// contract posts it to the ValidationRegistry under the tag "mandate-v1", once per request.
/// @dev Trust model (ARCHITECTURE §7, §9; docs/cre.md):
/// - On Monad testnet C is deployed with the CRE **MockKeystoneForwarder**, which verifies no
///   signatures and has a public `route()`: anyone can deliver any report, with any metadata. The
///   workflow-owner and workflow-name checks below therefore protect nothing there, and C is
///   **not a trust root**: no gate may require it. A C verdict is checkable because anyone can
///   re-execute it (`attest8004 verify`), not because of who delivered it.
/// - With the production KeystoneForwarder the metadata is signed by the DON, and the same checks
///   bind C to one owner's workflow of one name (names are unique per owner).
/// - Write-once: the registry lets a validator overwrite its own verdict, and the mock lets anyone
///   deliver, so C refuses a request that already has a response. On the mock that means whoever
///   delivers first fills C's slot; a forged verdict shows as MISMATCH under verify.
/// No owner, no setters, no funds, no upgrade path.
contract CreValidator is IReceiver {
    /// The tag every verdict is posted under; a report can't choose another.
    string public constant TAG = "mandate-v1";
    /// workflowId (32) ‖ workflowName (10) ‖ workflowOwner (20) ‖ reportId (2), as the forwarder
    /// passes rawReport[45:109].
    uint256 public constant METADATA_LENGTH = 64;

    /// The only caller of onReport.
    address public immutable forwarder;
    IValidationRegistry public immutable registry;
    /// The workflow owner the metadata must name (the simulator's placeholder on the mock).
    address public immutable workflowOwner;
    /// bytes10 of the first 10 hex characters of sha256(workflow name), as CRE encodes it.
    bytes10 public immutable workflowName;

    error ZeroAddress();
    error ZeroWorkflowName();
    error NotForwarder(address caller);
    error BadMetadataLength(uint256 length);
    error WrongWorkflowOwner(address owner);
    error WrongWorkflowName(bytes10 name);
    error ZeroResponseHash();
    error AlreadyAnswered(bytes32 requestHash);

    constructor(address forwarder_, address registry_, address workflowOwner_, bytes10 workflowName_) {
        if (forwarder_ == address(0) || registry_ == address(0) || workflowOwner_ == address(0)) revert ZeroAddress();
        if (workflowName_ == bytes10(0)) revert ZeroWorkflowName();
        forwarder = forwarder_;
        registry = IValidationRegistry(registry_);
        workflowOwner = workflowOwner_;
        workflowName = workflowName_;
    }

    /// @inheritdoc IReceiver
    /// @param report abi.encode(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash)
    /// @dev The registry still enforces that the request names this contract and that response <= 100.
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender);
        if (metadata.length != METADATA_LENGTH) revert BadMetadataLength(metadata.length);
        address owner = address(bytes20(metadata[42:62]));
        if (owner != workflowOwner) revert WrongWorkflowOwner(owner);
        bytes10 name = bytes10(metadata[32:42]);
        if (name != workflowName) revert WrongWorkflowName(name);

        (bytes32 requestHash, uint8 response, string memory responseURI, bytes32 responseHash) =
            abi.decode(report, (bytes32, uint8, string, bytes32));
        if (responseHash == bytes32(0)) revert ZeroResponseHash();
        // Reverts UnknownRequest for a request that doesn't exist.
        (,,, bytes32 postedHash, string memory postedTag,) = registry.getValidationStatus(requestHash);
        if (postedHash != bytes32(0) || bytes(postedTag).length != 0) revert AlreadyAnswered(requestHash);

        registry.validationResponse(requestHash, response, responseURI, responseHash, TAG);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
