// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {CreValidator} from "../src/CreValidator.sol";
import {IReceiver} from "../src/interfaces/IReceiver.sol";
import {ValidationRegistry} from "../src/ValidationRegistry.sol";
import {IValidationRegistry} from "../src/interfaces/IValidationRegistry.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

/// @notice Unit and fuzz tests for CreValidator (validator C, P11): only the forwarder may deliver,
/// the metadata must name our workflow, each request is answered once, and the tag is always
/// mandate-v1. A real ValidationRegistry stands behind it, so the registry's own rules (the named
/// validator, 0-100) are exercised too.
contract CreValidatorTest is Test {
    MockIdentityRegistry internal identity;
    ValidationRegistry internal registry;
    CreValidator internal c;

    address internal forwarder = makeAddr("forwarder");
    address internal owner = makeAddr("owner");
    address internal validatorA = makeAddr("validatorA");

    /// The CRE simulator's placeholder owner, and bytes10 of the first 10 hex characters of
    /// sha256("attest8004-validator-c") (the P11 spike observed this encoding).
    address internal constant WORKFLOW_OWNER = 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa;
    bytes10 internal constant WORKFLOW_NAME = 0x36386365303833636635;
    bytes32 internal constant WORKFLOW_ID =
        bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));

    bytes32 internal constant HASH = keccak256("attest8004.test.cre.1");
    string internal constant REQUEST_URI = "data:application/json,{}";
    string internal constant RESPONSE_URI = "data:application/json;base64,e30=";
    bytes32 internal constant RESPONSE_HASH = keccak256("{}");

    uint256 internal agentId;

    function setUp() public {
        identity = new MockIdentityRegistry();
        registry = new ValidationRegistry(address(identity));
        c = new CreValidator(forwarder, address(registry), WORKFLOW_OWNER, WORKFLOW_NAME);
        vm.prank(owner);
        agentId = identity.register();
    }

    // ---------------------------------------------------------------- helpers

    function _meta(bytes10 name, address wfOwner) internal pure returns (bytes memory) {
        return abi.encodePacked(WORKFLOW_ID, name, wfOwner, bytes2(0x0001));
    }

    function _meta() internal pure returns (bytes memory) {
        return _meta(WORKFLOW_NAME, WORKFLOW_OWNER);
    }

    function _report(bytes32 requestHash, uint8 response, bytes32 responseHash) internal pure returns (bytes memory) {
        return abi.encode(requestHash, response, RESPONSE_URI, responseHash);
    }

    function _request(address validator, bytes32 requestHash) internal {
        vm.prank(owner);
        registry.validationRequest(validator, agentId, REQUEST_URI, requestHash);
    }

    function _deliver(bytes memory metadata, bytes memory report) internal {
        vm.prank(forwarder);
        c.onReport(metadata, report);
    }

    // ---------------------------------------------------------------- the verdict

    function test_onReport_writesVerdictUnderMandateV1Tag() public {
        _request(address(c), HASH);
        vm.expectEmit(true, true, true, true, address(registry));
        emit IValidationRegistry.ValidationResponse(
            address(c), agentId, HASH, 100, RESPONSE_URI, RESPONSE_HASH, "mandate-v1"
        );
        _deliver(_meta(), _report(HASH, 100, RESPONSE_HASH));

        (address v, uint256 a, uint8 response, bytes32 responseHash, string memory tag,) =
            registry.getValidationStatus(HASH);
        assertEq(v, address(c));
        assertEq(a, agentId);
        assertEq(response, 100);
        assertEq(responseHash, RESPONSE_HASH);
        assertEq(tag, "mandate-v1");
    }

    function test_onReport_writesScoreZero() public {
        _request(address(c), HASH);
        _deliver(_meta(), _report(HASH, 0, RESPONSE_HASH));
        (,, uint8 response, bytes32 responseHash, string memory tag,) = registry.getValidationStatus(HASH);
        assertEq(response, 0);
        assertEq(responseHash, RESPONSE_HASH);
        assertEq(tag, "mandate-v1");
    }

    // ---------------------------------------------------------------- refusals

    function testFuzz_onReport_revertsUnlessForwarder(address caller) public {
        vm.assume(caller != forwarder);
        _request(address(c), HASH);
        vm.expectRevert(abi.encodeWithSelector(CreValidator.NotForwarder.selector, caller));
        vm.prank(caller);
        c.onReport(_meta(), _report(HASH, 100, RESPONSE_HASH));
    }

    function testFuzz_onReport_revertsOnMetadataLength(uint8 length) public {
        vm.assume(length != 64);
        _request(address(c), HASH);
        vm.expectRevert(abi.encodeWithSelector(CreValidator.BadMetadataLength.selector, uint256(length)));
        _deliver(new bytes(length), _report(HASH, 100, RESPONSE_HASH));
    }

    function test_onReport_revertsOnWrongOwner() public {
        _request(address(c), HASH);
        address other = makeAddr("otherOwner");
        vm.expectRevert(abi.encodeWithSelector(CreValidator.WrongWorkflowOwner.selector, other));
        _deliver(_meta(WORKFLOW_NAME, other), _report(HASH, 100, RESPONSE_HASH));
    }

    function test_onReport_revertsOnWrongName() public {
        _request(address(c), HASH);
        bytes10 other = bytes10("0123456789");
        vm.expectRevert(abi.encodeWithSelector(CreValidator.WrongWorkflowName.selector, other));
        _deliver(_meta(other, WORKFLOW_OWNER), _report(HASH, 100, RESPONSE_HASH));
    }

    function test_onReport_revertsOnZeroResponseHash() public {
        _request(address(c), HASH);
        vm.expectRevert(CreValidator.ZeroResponseHash.selector);
        _deliver(_meta(), _report(HASH, 100, bytes32(0)));
    }

    function test_onReport_revertsWhenAnswered() public {
        _request(address(c), HASH);
        _deliver(_meta(), _report(HASH, 100, RESPONSE_HASH));

        vm.expectRevert(abi.encodeWithSelector(CreValidator.AlreadyAnswered.selector, HASH));
        _deliver(_meta(), _report(HASH, 0, keccak256("other evidence")));

        (,, uint8 response, bytes32 responseHash,,) = registry.getValidationStatus(HASH);
        assertEq(response, 100, "the first verdict stays");
        assertEq(responseHash, RESPONSE_HASH);
    }

    function test_onReport_bubblesNotRequestedValidator() public {
        _request(validatorA, HASH);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.NotRequestedValidator.selector, HASH, address(c)));
        _deliver(_meta(), _report(HASH, 100, RESPONSE_HASH));
    }

    function test_onReport_bubblesUnknownRequest() public {
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.UnknownRequest.selector, HASH));
        _deliver(_meta(), _report(HASH, 100, RESPONSE_HASH));
    }

    function test_onReport_bubblesResponseOutOfRange() public {
        _request(address(c), HASH);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.ResponseOutOfRange.selector, uint8(101)));
        _deliver(_meta(), _report(HASH, 101, RESPONSE_HASH));
    }

    function test_onReport_revertsOnMalformedReport() public {
        _request(address(c), HASH);
        bytes memory full = _report(HASH, 100, RESPONSE_HASH);
        bytes memory truncated = new bytes(full.length - 40);
        for (uint256 i; i < truncated.length; ++i) {
            truncated[i] = full[i];
        }
        vm.expectRevert();
        _deliver(_meta(), truncated);
    }

    // ---------------------------------------------------------------- ERC-165

    function test_supportsInterface() public view {
        assertEq(type(IReceiver).interfaceId, bytes4(0x805f2132), "IReceiver id = onReport(bytes,bytes)");
        assertTrue(c.supportsInterface(0x805f2132), "IReceiver");
        assertTrue(c.supportsInterface(type(IERC165).interfaceId), "IERC165");
        assertFalse(c.supportsInterface(0xffffffff), "0xffffffff must be false (ERC-165)");
        assertFalse(c.supportsInterface(0x12345678));
        // What the production KeystoneForwarder asks before routing a report (OZ ERC165Checker).
        assertTrue(ERC165Checker.supportsInterface(address(c), 0x805f2132));
    }

    // ---------------------------------------------------------------- construction and shape

    function test_constructor_rejectsZeroArgs() public {
        vm.expectRevert(CreValidator.ZeroAddress.selector);
        new CreValidator(address(0), address(registry), WORKFLOW_OWNER, WORKFLOW_NAME);
        vm.expectRevert(CreValidator.ZeroAddress.selector);
        new CreValidator(forwarder, address(0), WORKFLOW_OWNER, WORKFLOW_NAME);
        vm.expectRevert(CreValidator.ZeroAddress.selector);
        new CreValidator(forwarder, address(registry), address(0), WORKFLOW_NAME);
        vm.expectRevert(CreValidator.ZeroWorkflowName.selector);
        new CreValidator(forwarder, address(registry), WORKFLOW_OWNER, bytes10(0));
    }

    function test_constructor_setsImmutables() public view {
        assertEq(c.forwarder(), forwarder);
        assertEq(address(c.registry()), address(registry));
        assertEq(c.workflowOwner(), WORKFLOW_OWNER);
        assertEq(c.workflowName(), WORKFLOW_NAME);
    }

    /// No owner, setters, funds or upgrade path: the compiled ABI is exactly these functions.
    function test_abiIsMinimal() public view {
        string memory artifact = vm.readFile("out/CreValidator.sol/CreValidator.json");
        string[] memory got = vm.parseJsonKeys(artifact, ".methodIdentifiers");
        string[8] memory want = [
            "METADATA_LENGTH()",
            "TAG()",
            "forwarder()",
            "onReport(bytes,bytes)",
            "registry()",
            "supportsInterface(bytes4)",
            "workflowName()",
            "workflowOwner()"
        ];
        assertEq(got.length, want.length, "function count");
        for (uint256 i; i < want.length; ++i) {
            bool found;
            for (uint256 j; j < got.length; ++j) {
                if (keccak256(bytes(got[j])) == keccak256(bytes(want[i]))) found = true;
            }
            assertTrue(found, want[i]);
        }
    }

    function test_rejectsValue() public {
        vm.deal(address(this), 1 ether);
        (bool plain,) = address(c).call{value: 1}("");
        assertFalse(plain, "no receive or fallback");
        _request(address(c), HASH);
        vm.deal(forwarder, 1 ether);
        vm.prank(forwarder);
        (bool withReport,) = address(c).call{value: 1}(
            abi.encodeCall(CreValidator.onReport, (_meta(), _report(HASH, 100, RESPONSE_HASH)))
        );
        assertFalse(withReport, "onReport is not payable");
    }
}
