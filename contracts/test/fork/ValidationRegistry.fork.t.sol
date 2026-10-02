// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {ValidationRegistry} from "../../src/ValidationRegistry.sol";
import {IIdentityRegistry} from "../../src/interfaces/IIdentityRegistry.sol";

/// @notice The parts of the canonical ERC-8004 Identity Registry these tests drive.
interface IERC8004IdentityRegistry is IIdentityRegistry {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function setApprovalForAll(address operator, bool approved) external;
    function approve(address to, uint256 agentId) external;
    function name() external view returns (string memory);
}

/// @notice Runs ValidationRegistry against the live canonical Identity Registry on a fork of
/// Monad testnet (SPEC §4.1). Forks the latest block, because Monad RPC nodes don't reliably
/// serve old state. Skipped when MONAD_TESTNET_RPC_URL is unset.
contract ValidationRegistryForkTest is Test {
    IERC8004IdentityRegistry internal constant IDENTITY =
        IERC8004IdentityRegistry(0x8004A818BFB912233c491871b3d84c89A494BD9e);

    ValidationRegistry internal registry;

    address internal alice = makeAddr("alice");
    address internal operator = makeAddr("operator");
    address internal approved = makeAddr("approved");
    address internal stranger = makeAddr("stranger");
    address internal validator = makeAddr("validator");

    bytes32 internal constant HASH = keccak256("attest8004.fork.request");
    string internal constant AGENT_URI = "data:application/json,{\"name\":\"attest8004-fork-test\"}";

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        registry = new ValidationRegistry(address(IDENTITY));
    }

    function _registerAlice() internal returns (uint256 agentId) {
        vm.prank(alice);
        agentId = IDENTITY.register(AGENT_URI);
        assertEq(IDENTITY.ownerOf(agentId), alice);
    }

    function testFork_CanonicalIdentityRegistryLive() public view {
        assertGt(address(IDENTITY).code.length, 0);
        assertEq(IDENTITY.name(), "AgentIdentity");
        assertEq(registry.getIdentityRegistry(), address(IDENTITY));
    }

    function testFork_RegisteredAgentOwner_RoundTrip() public {
        uint256 agentId = _registerAlice();

        vm.prank(alice);
        registry.validationRequest(validator, agentId, "data:application/json,{}", HASH);
        vm.prank(validator);
        registry.validationResponse(HASH, 100, "data:application/json,{}", keccak256("{}"), "fork-test");

        (address v, uint256 id, uint8 r, bytes32 rh, string memory tag, uint256 lastUpdate) =
            registry.getValidationStatus(HASH);
        assertEq(v, validator);
        assertEq(id, agentId);
        assertEq(r, 100);
        assertEq(rh, keccak256("{}"));
        assertEq(tag, "fork-test");
        assertEq(lastUpdate, block.timestamp);

        address[] memory filter = new address[](1);
        filter[0] = validator;
        (uint64 count, uint8 avg) = registry.getSummary(agentId, filter, "fork-test");
        assertEq(count, 1);
        assertEq(avg, 100);
    }

    function testFork_OperatorViaSetApprovalForAll() public {
        uint256 agentId = _registerAlice();
        vm.prank(alice);
        IDENTITY.setApprovalForAll(operator, true);

        vm.prank(operator);
        registry.validationRequest(validator, agentId, "", HASH);

        (, uint256 id,,,,) = registry.getValidationStatus(HASH);
        assertEq(id, agentId);
    }

    function testFork_TokenApproved() public {
        uint256 agentId = _registerAlice();
        vm.prank(alice);
        IDENTITY.approve(approved, agentId);

        vm.prank(approved);
        registry.validationRequest(validator, agentId, "", HASH);

        (, uint256 id,,,,) = registry.getValidationStatus(HASH);
        assertEq(id, agentId);
    }

    function testFork_StrangerReverts() public {
        uint256 agentId = _registerAlice();

        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.NotAgentOwnerOrOperator.selector, agentId, stranger));
        vm.prank(stranger);
        registry.validationRequest(validator, agentId, "", HASH);
    }

    function testFork_ExistingAgent1Owner_CanRequest() public {
        address owner1 = IDENTITY.ownerOf(1);

        vm.prank(owner1);
        registry.validationRequest(validator, 1, "", HASH);

        (address v, uint256 id,,,,) = registry.getValidationStatus(HASH);
        assertEq(v, validator);
        assertEq(id, 1);
    }
}
