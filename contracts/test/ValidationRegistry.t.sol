// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ValidationRegistry} from "../src/ValidationRegistry.sol";
import {IValidationRegistry} from "../src/interfaces/IValidationRegistry.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

/// @notice Unit and fuzz tests for SPEC §4.1. Behaviour follows EIP-8004 and the
/// reference implementation; every deliberate difference is in docs/spec-notes.md.
contract ValidationRegistryTest is Test {
    MockIdentityRegistry internal identity;
    ValidationRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal approved = makeAddr("approved");
    address internal stranger = makeAddr("stranger");
    address internal validatorA = makeAddr("validatorA");
    address internal validatorB = makeAddr("validatorB");

    uint256 internal agentId;

    bytes32 internal constant HASH = keccak256("attest8004.test.request.1");
    string internal constant REQUEST_URI = "data:application/json,{}";
    string internal constant RESPONSE_URI = "ipfs://evidence";
    bytes32 internal constant RESPONSE_HASH = keccak256("evidence");
    string internal constant TAG = "mandate-v1";

    function setUp() public {
        identity = new MockIdentityRegistry();
        registry = new ValidationRegistry(address(identity));
        vm.prank(owner);
        agentId = identity.register();
    }

    // ---------------------------------------------------------------- helpers

    function _request(address caller, address validator, uint256 id, bytes32 requestHash) internal {
        vm.prank(caller);
        registry.validationRequest(validator, id, REQUEST_URI, requestHash);
    }

    function _respond(address validator, bytes32 requestHash, uint8 response, string memory tag) internal {
        vm.prank(validator);
        registry.validationResponse(requestHash, response, RESPONSE_URI, RESPONSE_HASH, tag);
    }

    function _h(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("attest8004.test.request", i));
    }

    function _none() internal pure returns (address[] memory) {
        return new address[](0);
    }

    function _only(address a) internal pure returns (address[] memory f) {
        f = new address[](1);
        f[0] = a;
    }

    function _pair(address a, address b) internal pure returns (address[] memory f) {
        f = new address[](2);
        f[0] = a;
        f[1] = b;
    }

    function _assertSummary(address[] memory filter, string memory tag, uint64 count, uint8 avg) internal view {
        (uint64 gotCount, uint8 gotAvg) = registry.getSummary(agentId, filter, tag);
        assertEq(gotCount, count, "count");
        assertEq(gotAvg, avg, "averageResponse");
    }

    function _notAuthorised(uint256 id, address caller) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ValidationRegistry.NotAgentOwnerOrOperator.selector, id, caller);
    }

    function _transferAgent(address to) internal {
        vm.prank(owner);
        identity.transferFrom(owner, to, agentId);
    }

    /// h1: validator A, "mandate-v1", 100 · h2: validator B, "risk-qwen-v1", 40 · h3: validator A, "risk-qwen-v1", 70
    function _threeResponses() internal {
        _request(owner, validatorA, agentId, _h(1));
        _request(owner, validatorB, agentId, _h(2));
        _request(owner, validatorA, agentId, _h(3));
        _respond(validatorA, _h(1), 100, "mandate-v1");
        _respond(validatorB, _h(2), 40, "risk-qwen-v1");
        _respond(validatorA, _h(3), 70, "risk-qwen-v1");
    }

    // ------------------------------------------------------------- interface

    function test_Interface_MatchesEip8004Signatures() public pure {
        assertEq(
            IValidationRegistry.validationRequest.selector,
            bytes4(keccak256("validationRequest(address,uint256,string,bytes32)"))
        );
        assertEq(IValidationRegistry.validationRequest.selector, bytes4(0xaaf400c4));
        assertEq(
            IValidationRegistry.validationResponse.selector,
            bytes4(keccak256("validationResponse(bytes32,uint8,string,bytes32,string)"))
        );
        assertEq(IValidationRegistry.validationResponse.selector, bytes4(0x3d659a96));
        assertEq(IValidationRegistry.getValidationStatus.selector, bytes4(keccak256("getValidationStatus(bytes32)")));
        assertEq(IValidationRegistry.getSummary.selector, bytes4(keccak256("getSummary(uint256,address[],string)")));
        assertEq(IValidationRegistry.getAgentValidations.selector, bytes4(keccak256("getAgentValidations(uint256)")));
        assertEq(IValidationRegistry.getValidatorRequests.selector, bytes4(keccak256("getValidatorRequests(address)")));
        assertEq(IValidationRegistry.getIdentityRegistry.selector, bytes4(keccak256("getIdentityRegistry()")));
        assertEq(
            IValidationRegistry.ValidationRequest.selector,
            keccak256("ValidationRequest(address,uint256,string,bytes32)")
        );
        assertEq(
            IValidationRegistry.ValidationResponse.selector,
            keccak256("ValidationResponse(address,uint256,bytes32,uint8,string,bytes32,string)")
        );
    }

    // ----------------------------------------------------------- constructor

    function test_Constructor_RevertWhen_ZeroIdentityRegistry() public {
        vm.expectRevert(ValidationRegistry.ZeroIdentityRegistry.selector);
        new ValidationRegistry(address(0));
    }

    function test_GetIdentityRegistry() public view {
        assertEq(registry.getIdentityRegistry(), address(identity));
    }

    // --------------------------------------------------------- authorisation

    function test_Request_ByOwner_StoresAndEmits() public {
        vm.recordLogs();
        _request(owner, validatorA, agentId, HASH);

        // Event layout pinned exactly: three indexed topics, requestURI in data.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(registry));
        assertEq(logs[0].topics.length, 4);
        assertEq(logs[0].topics[0], IValidationRegistry.ValidationRequest.selector);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(validatorA))));
        assertEq(logs[0].topics[2], bytes32(agentId));
        assertEq(logs[0].topics[3], HASH);
        assertEq(abi.decode(logs[0].data, (string)), REQUEST_URI);

        (address v, uint256 id, uint8 r, bytes32 rh, string memory tag, uint256 lastUpdate) =
            registry.getValidationStatus(HASH);
        assertEq(v, validatorA);
        assertEq(id, agentId);
        assertEq(r, 0);
        assertEq(rh, bytes32(0));
        assertEq(tag, "");
        assertEq(lastUpdate, block.timestamp);
    }

    function test_Request_ByApprovedForAllOperator() public {
        vm.prank(owner);
        identity.setApprovalForAll(operator, true);

        _request(operator, validatorA, agentId, HASH);

        (address v, uint256 id,,,,) = registry.getValidationStatus(HASH);
        assertEq(v, validatorA);
        assertEq(id, agentId);
    }

    function test_Request_ByTokenApproved() public {
        vm.prank(owner);
        identity.approve(approved, agentId);

        _request(approved, validatorA, agentId, HASH);

        (address v,,,,,) = registry.getValidationStatus(HASH);
        assertEq(v, validatorA);
    }

    function test_Request_RevertWhen_Stranger() public {
        vm.expectRevert(_notAuthorised(agentId, stranger));
        _request(stranger, validatorA, agentId, HASH);
    }

    function test_Request_RevertWhen_OperatorRevoked() public {
        vm.startPrank(owner);
        identity.setApprovalForAll(operator, true);
        identity.setApprovalForAll(operator, false);
        vm.stopPrank();

        vm.expectRevert(_notAuthorised(agentId, operator));
        _request(operator, validatorA, agentId, HASH);
    }

    function test_Request_AfterTransfer_NewOwnerAllowed_OldOwnerAndOldApprovedRejected() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        identity.approve(approved, agentId);
        _transferAgent(newOwner);

        vm.expectRevert(_notAuthorised(agentId, owner));
        _request(owner, validatorA, agentId, HASH);

        // ERC-721 clears the token approval on transfer.
        vm.expectRevert(_notAuthorised(agentId, approved));
        _request(approved, validatorA, agentId, HASH);

        _request(newOwner, validatorA, agentId, HASH);
        (, uint256 id,,,,) = registry.getValidationStatus(HASH);
        assertEq(id, agentId);
    }

    function test_Request_RevertWhen_AgentDoesNotExist() public {
        uint256 missing = agentId + 1;
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, missing));
        _request(owner, validatorA, missing, HASH);
    }

    function test_Request_RevertWhen_ZeroValidator() public {
        vm.expectRevert(ValidationRegistry.ZeroValidator.selector);
        _request(owner, address(0), agentId, HASH);
    }

    function test_Request_RevertWhen_DuplicateHash_SameOrOtherValidator() public {
        _request(owner, validatorA, agentId, HASH);

        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.RequestExists.selector, HASH));
        _request(owner, validatorA, agentId, HASH);

        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.RequestExists.selector, HASH));
        _request(owner, validatorB, agentId, HASH);
    }

    /// The EIP keys requests globally by requestHash, so another agent's owner can claim a
    /// hash first. The stored entry names the squatter's agent and validator, which is why
    /// consumers (the P2 gate) must check both and not only the score.
    function test_Request_RevertWhen_HashSquattedByOtherAgent() public {
        address squatter = makeAddr("squatter");
        vm.prank(squatter);
        uint256 squatterAgent = identity.register();
        _request(squatter, stranger, squatterAgent, HASH);

        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.RequestExists.selector, HASH));
        _request(owner, validatorA, agentId, HASH);

        (address v, uint256 id,,,,) = registry.getValidationStatus(HASH);
        assertEq(v, stranger);
        assertEq(id, squatterAgent);
    }

    // ------------------------------------------------------------- responses

    function test_Response_StoresAndEmits() public {
        _request(owner, validatorA, agentId, HASH);
        vm.warp(block.timestamp + 60);

        vm.recordLogs();
        _respond(validatorA, HASH, 87, TAG);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(registry));
        assertEq(logs[0].topics.length, 4);
        assertEq(logs[0].topics[0], IValidationRegistry.ValidationResponse.selector);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(validatorA))));
        assertEq(logs[0].topics[2], bytes32(agentId));
        assertEq(logs[0].topics[3], HASH);
        (uint8 r, string memory uri, bytes32 rh, string memory tag) =
            abi.decode(logs[0].data, (uint8, string, bytes32, string));
        assertEq(r, 87);
        assertEq(uri, RESPONSE_URI);
        assertEq(rh, RESPONSE_HASH);
        assertEq(tag, TAG);

        (address v, uint256 id, uint8 sr, bytes32 srh, string memory stag, uint256 lastUpdate) =
            registry.getValidationStatus(HASH);
        assertEq(v, validatorA);
        assertEq(id, agentId);
        assertEq(sr, 87);
        assertEq(srh, RESPONSE_HASH);
        assertEq(stag, TAG);
        assertEq(lastUpdate, block.timestamp);
    }

    function test_Response_AcceptsBounds_0_and_100() public {
        _request(owner, validatorA, agentId, HASH);

        _respond(validatorA, HASH, 0, TAG);
        (,, uint8 r,,,) = registry.getValidationStatus(HASH);
        assertEq(r, 0);

        _respond(validatorA, HASH, 100, TAG);
        (,, r,,,) = registry.getValidationStatus(HASH);
        assertEq(r, 100);
    }

    function test_Response_RevertWhen_Above100() public {
        _request(owner, validatorA, agentId, HASH);

        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.ResponseOutOfRange.selector, uint8(101)));
        _respond(validatorA, HASH, 101, TAG);

        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.ResponseOutOfRange.selector, uint8(255)));
        _respond(validatorA, HASH, 255, TAG);
    }

    function test_Response_RevertWhen_UnknownRequest() public {
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.UnknownRequest.selector, HASH));
        _respond(validatorA, HASH, 100, TAG);
    }

    function test_Response_RevertWhen_WrongValidator() public {
        _request(owner, validatorA, agentId, HASH);

        address[3] memory callers = [owner, validatorB, stranger];
        for (uint256 i; i < callers.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.NotRequestedValidator.selector, HASH, callers[i]));
            _respond(callers[i], HASH, 100, TAG);
        }
    }

    function test_Response_Repeated_StoresLatestAndLastUpdate() public {
        _request(owner, validatorA, agentId, HASH);
        _respond(validatorA, HASH, 40, "soft-finality");

        uint256 later = block.timestamp + 100;
        vm.warp(later);
        vm.prank(validatorA);
        registry.validationResponse(HASH, 90, "ipfs://final", keccak256("final"), "hard-finality");

        (address v,, uint8 r, bytes32 rh, string memory tag, uint256 lastUpdate) = registry.getValidationStatus(HASH);
        assertEq(v, validatorA);
        assertEq(r, 90);
        assertEq(rh, keccak256("final"));
        assertEq(tag, "hard-finality");
        assertEq(lastUpdate, later);
    }

    function test_Response_OptionalFieldsEmpty() public {
        _request(owner, validatorA, agentId, HASH);

        vm.prank(validatorA);
        registry.validationResponse(HASH, 100, "", bytes32(0), "");

        (,, uint8 r, bytes32 rh, string memory tag,) = registry.getValidationStatus(HASH);
        assertEq(r, 100);
        assertEq(rh, bytes32(0));
        assertEq(tag, "");
        _assertSummary(_none(), "", 1, 100);
    }

    function test_Response_AfterAgentTransfer_StillAccepted() public {
        _request(owner, validatorA, agentId, HASH);
        _transferAgent(makeAddr("newOwner"));

        _respond(validatorA, HASH, 100, TAG);

        (, uint256 id, uint8 r,,,) = registry.getValidationStatus(HASH);
        assertEq(id, agentId);
        assertEq(r, 100);
    }

    // ----------------------------------------------------------------- reads

    function test_GetValidationStatus_RevertWhen_Unknown() public {
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.UnknownRequest.selector, HASH));
        registry.getValidationStatus(HASH);
    }

    /// The EIP read interface cannot tell "pending" from "responded 0": both read response 0.
    /// Consumers must therefore require a minimum score of at least 1.
    function test_GetValidationStatus_Pending() public {
        uint256 requestedAt = block.timestamp + 1234;
        vm.warp(requestedAt);
        _request(owner, validatorA, agentId, HASH);
        vm.warp(requestedAt + 50);

        (address v, uint256 id, uint8 r, bytes32 rh, string memory tag, uint256 lastUpdate) =
            registry.getValidationStatus(HASH);
        assertEq(v, validatorA);
        assertEq(id, agentId);
        assertEq(r, 0);
        assertEq(rh, bytes32(0));
        assertEq(tag, "");
        assertEq(lastUpdate, requestedAt);
        _assertSummary(_none(), "", 0, 0);
    }

    function test_AgentAndValidatorLists_InRequestOrder() public {
        address otherOwner = makeAddr("otherOwner");
        vm.prank(otherOwner);
        uint256 otherAgent = identity.register();

        _request(owner, validatorA, agentId, _h(1));
        _request(owner, validatorB, agentId, _h(2));
        _request(owner, validatorA, agentId, _h(3));
        _request(otherOwner, validatorA, otherAgent, _h(4));

        bytes32[] memory agentList = new bytes32[](3);
        (agentList[0], agentList[1], agentList[2]) = (_h(1), _h(2), _h(3));
        assertEq(registry.getAgentValidations(agentId), agentList);

        bytes32[] memory otherList = new bytes32[](1);
        otherList[0] = _h(4);
        assertEq(registry.getAgentValidations(otherAgent), otherList);

        bytes32[] memory aList = new bytes32[](3);
        (aList[0], aList[1], aList[2]) = (_h(1), _h(3), _h(4));
        assertEq(registry.getValidatorRequests(validatorA), aList);

        bytes32[] memory bList = new bytes32[](1);
        bList[0] = _h(2);
        assertEq(registry.getValidatorRequests(validatorB), bList);

        assertEq(registry.getValidatorRequests(stranger).length, 0);
        assertEq(registry.getAgentValidations(otherAgent + 1).length, 0);
    }

    // --------------------------------------------------------------- summary

    function test_Summary_Empty_ReturnsZeroZero() public view {
        _assertSummary(_none(), "", 0, 0);
    }

    function test_Summary_ExcludesPending() public {
        _request(owner, validatorA, agentId, _h(1));
        _request(owner, validatorA, agentId, _h(2));
        _respond(validatorA, _h(1), 80, TAG);

        _assertSummary(_none(), "", 1, 80);
        _assertSummary(_only(validatorA), "", 1, 80);
    }

    function test_Summary_FloorAverage() public {
        _request(owner, validatorA, agentId, _h(1));
        _request(owner, validatorA, agentId, _h(2));
        _request(owner, validatorA, agentId, _h(3));
        _respond(validatorA, _h(1), 100, TAG);
        _respond(validatorA, _h(2), 0, TAG);
        _respond(validatorA, _h(3), 50, TAG);
        _assertSummary(_none(), "", 3, 50);

        address otherOwner = makeAddr("otherOwner");
        vm.prank(otherOwner);
        uint256 otherAgent = identity.register();
        _request(otherOwner, validatorA, otherAgent, _h(4));
        _request(otherOwner, validatorA, otherAgent, _h(5));
        _respond(validatorA, _h(4), 100, TAG);
        _respond(validatorA, _h(5), 99, TAG);

        (uint64 count, uint8 avg) = registry.getSummary(otherAgent, _none(), "");
        assertEq(count, 2);
        assertEq(avg, 99); // floor(199 / 2)
    }

    function test_Summary_FilterByValidators() public {
        _threeResponses();
        _assertSummary(_only(validatorA), "", 2, 85);
        _assertSummary(_only(validatorB), "", 1, 40);
        _assertSummary(_pair(validatorA, validatorB), "", 3, 70);
        _assertSummary(_only(stranger), "", 0, 0);
    }

    function test_Summary_DuplicateFilterAddressesCountOnce() public {
        _threeResponses();
        address[] memory filter = new address[](3);
        (filter[0], filter[1], filter[2]) = (validatorA, validatorA, validatorB);
        _assertSummary(filter, "", 3, 70);
        _assertSummary(_pair(validatorA, validatorA), "", 2, 85);
    }

    function test_Summary_FilterByTag() public {
        _threeResponses();
        _assertSummary(_none(), "mandate-v1", 1, 100);
        _assertSummary(_none(), "risk-qwen-v1", 2, 55);
        _assertSummary(_none(), "unknown-tag", 0, 0);
        _assertSummary(_none(), "", 3, 70);
    }

    function test_Summary_FilterByValidatorsAndTag() public {
        _threeResponses();
        _assertSummary(_only(validatorA), "risk-qwen-v1", 1, 70);
        _assertSummary(_only(validatorA), "mandate-v1", 1, 100);
        _assertSummary(_only(validatorB), "mandate-v1", 0, 0);
        _assertSummary(_pair(validatorA, validatorB), "risk-qwen-v1", 2, 55);
    }

    function test_Summary_UsesLatestResponse() public {
        _request(owner, validatorA, agentId, HASH);
        _respond(validatorA, HASH, 20, "soft");
        _respond(validatorA, HASH, 100, "hard");

        _assertSummary(_none(), "", 1, 100);
        _assertSummary(_none(), "soft", 0, 0);
        _assertSummary(_none(), "hard", 1, 100);
    }

    function test_Summary_IgnoresOtherAgents() public {
        address otherOwner = makeAddr("otherOwner");
        vm.prank(otherOwner);
        uint256 otherAgent = identity.register();
        _request(otherOwner, validatorA, otherAgent, _h(9));
        _respond(validatorA, _h(9), 0, TAG);

        _request(owner, validatorA, agentId, HASH);
        _respond(validatorA, HASH, 100, TAG);

        _assertSummary(_none(), "", 1, 100);
        _assertSummary(_only(validatorA), TAG, 1, 100);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_Response_RangeEnforced(uint8 r) public {
        _request(owner, validatorA, agentId, HASH);

        if (r > 100) {
            vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.ResponseOutOfRange.selector, r));
        }
        _respond(validatorA, HASH, r, TAG);

        if (r <= 100) {
            (,, uint8 got,,,) = registry.getValidationStatus(HASH);
            assertEq(got, r);
        }
    }

    function testFuzz_OnlyNamedValidatorCanRespond(address caller) public {
        _request(owner, validatorA, agentId, HASH);

        if (caller != validatorA) {
            vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.NotRequestedValidator.selector, HASH, caller));
        }
        _respond(caller, HASH, 100, TAG);
    }

    function testFuzz_OnlyOwnerOrOperatorCanRequest(address caller) public {
        vm.startPrank(owner);
        identity.setApprovalForAll(operator, true);
        identity.approve(approved, agentId);
        vm.stopPrank();

        bool allowed = caller == owner || caller == operator || caller == approved;
        if (!allowed) vm.expectRevert(_notAuthorised(agentId, caller));
        _request(caller, validatorA, agentId, HASH);

        if (allowed) {
            (address v,,,,,) = registry.getValidationStatus(HASH);
            assertEq(v, validatorA);
        }
    }

    function testFuzz_StatusRoundTrip(bytes32 requestHash, uint8 r, bytes32 respHash, string calldata tag) public {
        r = uint8(bound(r, 0, 100));
        _request(owner, validatorA, agentId, requestHash);
        vm.warp(block.timestamp + 7);
        vm.prank(validatorA);
        registry.validationResponse(requestHash, r, "uri", respHash, tag);

        (address v, uint256 id, uint8 sr, bytes32 srh, string memory stag, uint256 lastUpdate) =
            registry.getValidationStatus(requestHash);
        assertEq(v, validatorA);
        assertEq(id, agentId);
        assertEq(sr, r);
        assertEq(srh, respHash);
        assertEq(stag, tag);
        assertEq(lastUpdate, block.timestamp);
    }

    /// Eight requests; bit i of each mask picks validator A or B, tag "t1" or "t2", and whether
    /// request i has a response. A reference model computes (count, floor average) for every
    /// combination of validator filter and tag filter.
    function testFuzz_Summary_MatchesModel(
        uint8[8] memory responses,
        uint8 validatorMask,
        uint8 tagMask,
        uint8 respondedMask
    ) public {
        address[8] memory validatorOf;
        string[8] memory tagOf;
        for (uint256 i; i < 8; i++) {
            validatorOf[i] = (validatorMask >> i) & 1 == 1 ? validatorA : validatorB;
            tagOf[i] = (tagMask >> i) & 1 == 1 ? "t1" : "t2";
            responses[i] = uint8(bound(responses[i], 0, 100));
            _request(owner, validatorOf[i], agentId, _h(i));
            if ((respondedMask >> i) & 1 == 1) _respond(validatorOf[i], _h(i), responses[i], tagOf[i]);
        }

        address[][4] memory filters = [_none(), _only(validatorA), _only(validatorB), _pair(validatorA, validatorB)];
        string[4] memory tags = ["", "t1", "t2", "t3"];
        for (uint256 f; f < filters.length; f++) {
            for (uint256 t; t < tags.length; t++) {
                uint256 count;
                uint256 total;
                for (uint256 i; i < 8; i++) {
                    if ((respondedMask >> i) & 1 == 0) continue;
                    bool validatorMatch = filters[f].length == 0;
                    for (uint256 j; j < filters[f].length; j++) {
                        if (filters[f][j] == validatorOf[i]) validatorMatch = true;
                    }
                    bool tagMatch =
                        bytes(tags[t]).length == 0 || keccak256(bytes(tags[t])) == keccak256(bytes(tagOf[i]));
                    if (validatorMatch && tagMatch) {
                        count++;
                        total += responses[i];
                    }
                }
                _assertSummary(filters[f], tags[t], uint64(count), count == 0 ? 0 : uint8(total / count));
            }
        }
    }
}
