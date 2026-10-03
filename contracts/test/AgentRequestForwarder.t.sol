// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {AgentRequestForwarder} from "../src/AgentRequestForwarder.sol";
import {ValidationRegistry} from "../src/ValidationRegistry.sol";
import {IValidationRegistry} from "../src/interfaces/IValidationRegistry.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

/// @notice SPEC §4.4: the forwarder lets an agent's hot key call validationRequest for that agent,
/// and nothing else. The owner approves the forwarder once with setApprovalForAll and registers the
/// key with setAgentKey; the key works only while the owner who set it still owns the agent.
contract AgentRequestForwarderTest is Test {
    MockIdentityRegistry internal identity;
    ValidationRegistry internal registry;
    AgentRequestForwarder internal forwarder;

    address internal owner = makeAddr("owner");
    address internal newOwner = makeAddr("newOwner");
    address internal stranger = makeAddr("stranger");
    address internal key1 = makeAddr("key1");
    address internal key2 = makeAddr("key2");
    address internal validator = makeAddr("validator");

    uint256 internal agent1;
    uint256 internal agent2;
    uint256 internal strangerAgent;

    string internal constant URI = "data:application/json;base64,e30=";
    bytes32 internal constant HASH = keccak256("attest8004.forwarder.request");

    event AgentKeySet(uint256 indexed agentId, address indexed owner, address indexed key);
    event ValidationRequest(
        address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash
    );

    function setUp() public {
        identity = new MockIdentityRegistry();
        registry = new ValidationRegistry(address(identity));
        forwarder = new AgentRequestForwarder(address(registry));

        vm.startPrank(owner);
        agent1 = identity.register();
        agent2 = identity.register();
        identity.setApprovalForAll(address(forwarder), true);
        forwarder.setAgentKey(agent1, key1);
        forwarder.setAgentKey(agent2, key2);
        vm.stopPrank();

        vm.prank(stranger);
        strangerAgent = identity.register();
    }

    // ----------------------------------------------------------- constructor

    function test_Constructor_ReadsIdentityRegistryFromValidationRegistry() public view {
        assertEq(address(forwarder.validationRegistry()), address(registry));
        assertEq(address(forwarder.identityRegistry()), address(identity));
    }

    function test_Constructor_RevertWhen_ZeroValidationRegistry() public {
        vm.expectRevert(AgentRequestForwarder.ZeroValidationRegistry.selector);
        new AgentRequestForwarder(address(0));
    }

    // ----------------------------------------------------------- setAgentKey

    function test_SetAgentKey_ByOwner_StoresKeyAndOwner() public {
        address fresh = makeAddr("fresh");
        vm.expectEmit(address(forwarder));
        emit AgentKeySet(agent1, owner, fresh);
        vm.prank(owner);
        forwarder.setAgentKey(agent1, fresh);

        (address key, address recordedOwner) = forwarder.agentKeyOf(agent1);
        assertEq(key, fresh);
        assertEq(recordedOwner, owner);
    }

    function test_SetAgentKey_RevertWhen_Stranger() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRequestForwarder.NotAgentOwner.selector, agent1, stranger));
        vm.prank(stranger);
        forwarder.setAgentKey(agent1, stranger);
    }

    /// An ERC-721 operator of the owner is not the owner: only ownerOf may set the key.
    function test_SetAgentKey_RevertWhen_OperatorNotOwner() public {
        address operator = makeAddr("operator");
        vm.prank(owner);
        identity.setApprovalForAll(operator, true);

        vm.expectRevert(abi.encodeWithSelector(AgentRequestForwarder.NotAgentOwner.selector, agent1, operator));
        vm.prank(operator);
        forwarder.setAgentKey(agent1, operator);
    }

    function test_SetAgentKey_RevertWhen_KeyItself() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRequestForwarder.NotAgentOwner.selector, agent1, key1));
        vm.prank(key1);
        forwarder.setAgentKey(agent1, key2);
    }

    function test_SetAgentKey_RevertWhen_AgentDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        vm.prank(owner);
        forwarder.setAgentKey(99, key1);
    }

    function test_SetAgentKey_Rotate_OldKeyRejected() public {
        address rotated = makeAddr("rotated");
        vm.prank(owner);
        forwarder.setAgentKey(agent1, rotated);

        vm.expectRevert(abi.encodeWithSelector(AgentRequestForwarder.NotAgentKey.selector, agent1, key1));
        vm.prank(key1);
        forwarder.request(validator, agent1, URI, HASH);

        vm.prank(rotated);
        forwarder.request(validator, agent1, URI, HASH);
        (address v, uint256 id,,,,) = registry.getValidationStatus(HASH);
        assertEq(v, validator);
        assertEq(id, agent1);
    }

    // ----------------------------------------------------------- request

    function test_Request_ByAgentKey_RecordsRequest() public {
        vm.expectEmit(address(registry));
        emit ValidationRequest(validator, agent1, URI, HASH);
        vm.prank(key1);
        forwarder.request(validator, agent1, URI, HASH);

        (address v, uint256 id, uint8 response,,,) = registry.getValidationStatus(HASH);
        assertEq(v, validator);
        assertEq(id, agent1);
        assertEq(response, 0);
        assertEq(registry.getAgentValidations(agent1).length, 1);
    }

    function test_Request_RevertWhen_WrongKey() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRequestForwarder.NotAgentKey.selector, agent1, stranger));
        vm.prank(stranger);
        forwarder.request(validator, agent1, URI, HASH);
    }

    /// Both agents share one owner and one setApprovalForAll, but each key works only for its agent.
    function test_Request_RevertWhen_KeyOfAnotherAgent() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRequestForwarder.NotAgentKey.selector, agent1, key2));
        vm.prank(key2);
        forwarder.request(validator, agent1, URI, HASH);
    }

    /// The owner can call the registry directly; through the forwarder only the key may request.
    function test_Request_RevertWhen_OwnerIsNotTheKey() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRequestForwarder.NotAgentKey.selector, agent1, owner));
        vm.prank(owner);
        forwarder.request(validator, agent1, URI, HASH);
    }

    /// With no key set, the record is (0, 0); even address(0) as the caller must not match it.
    function test_Request_RevertWhen_NoKeySet() public {
        vm.prank(stranger);
        identity.setApprovalForAll(address(forwarder), true);

        vm.expectRevert(abi.encodeWithSelector(AgentRequestForwarder.NotAgentKey.selector, strangerAgent, address(0)));
        vm.prank(address(0));
        forwarder.request(validator, strangerAgent, URI, HASH);
    }

    function test_Request_RevertWhen_KeyRevoked() public {
        vm.expectEmit(address(forwarder));
        emit AgentKeySet(agent1, owner, address(0));
        vm.prank(owner);
        forwarder.setAgentKey(agent1, address(0));

        vm.expectRevert(abi.encodeWithSelector(AgentRequestForwarder.NotAgentKey.selector, agent1, key1));
        vm.prank(key1);
        forwarder.request(validator, agent1, URI, HASH);
    }

    /// The new owner also approved the forwarder (for their own agents), so the registry alone would
    /// accept the call: the forwarder must refuse a key that the previous owner set.
    function test_Request_RevertWhen_AgentTransferred_KeyFromPreviousOwner() public {
        vm.prank(owner);
        identity.transferFrom(owner, newOwner, agent1);
        vm.prank(newOwner);
        identity.setApprovalForAll(address(forwarder), true);

        vm.expectRevert(abi.encodeWithSelector(AgentRequestForwarder.StaleAgentKey.selector, agent1, owner, newOwner));
        vm.prank(key1);
        forwarder.request(validator, agent1, URI, HASH);
    }

    function test_Request_AfterTransfer_NewOwnerSetsKey() public {
        address keyN = makeAddr("keyN");
        vm.prank(owner);
        identity.transferFrom(owner, newOwner, agent1);
        vm.startPrank(newOwner);
        identity.setApprovalForAll(address(forwarder), true);
        forwarder.setAgentKey(agent1, keyN);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(AgentRequestForwarder.NotAgentKey.selector, agent1, key1));
        vm.prank(key1);
        forwarder.request(validator, agent1, URI, HASH);

        vm.prank(keyN);
        forwarder.request(validator, agent1, URI, HASH);
        (, uint256 id,,,,) = registry.getValidationStatus(HASH);
        assertEq(id, agent1);
    }

    /// Pinned behaviour (ARCHITECTURE §7): if the agent comes back to the owner who set the key, the
    /// recorded owner is ownerOf again, so that owner's key works again. The owner can revoke it.
    function test_Request_KeyRevivesWhenAgentReturnsToKeyOwner() public {
        vm.prank(owner);
        identity.transferFrom(owner, newOwner, agent1);
        vm.prank(newOwner);
        identity.transferFrom(newOwner, owner, agent1);

        vm.prank(key1);
        forwarder.request(validator, agent1, URI, HASH);
        (, uint256 id,,,,) = registry.getValidationStatus(HASH);
        assertEq(id, agent1);
    }

    function test_Request_RevertWhen_OwnerRevokedForwarderApproval() public {
        vm.prank(owner);
        identity.setApprovalForAll(address(forwarder), false);

        vm.expectRevert(
            abi.encodeWithSelector(ValidationRegistry.NotAgentOwnerOrOperator.selector, agent1, address(forwarder))
        );
        vm.prank(key1);
        forwarder.request(validator, agent1, URI, HASH);
    }

    function test_Request_RevertWhen_HashAlreadyRequested() public {
        vm.prank(key1);
        forwarder.request(validator, agent1, URI, HASH);

        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.RequestExists.selector, HASH));
        vm.prank(key1);
        forwarder.request(validator, agent1, URI, HASH);
    }

    // ----------------------------------------------------------- it can do nothing else

    /// The forwarder's only state-changing call is validationRequest on the fixed registry, with
    /// exactly the caller's arguments and no value. Its other calls are static reads of ownerOf.
    function test_Request_MakesExactlyOneCall_ValidationRequestOnTheRegistry() public {
        vm.startStateDiffRecording();
        vm.prank(key1);
        forwarder.request(validator, agent1, URI, HASH);
        VmSafe.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();

        uint256 calls;
        uint256 staticCalls;
        for (uint256 i; i < accesses.length; ++i) {
            VmSafe.AccountAccess memory a = accesses[i];
            if (a.accessor != address(forwarder) || a.kind == VmSafe.AccountAccessKind.Resume) continue;
            if (a.kind == VmSafe.AccountAccessKind.Call) {
                ++calls;
                assertEq(a.account, address(registry), "call target");
                assertEq(a.value, 0, "call value");
                assertEq(
                    a.data,
                    abi.encodeCall(IValidationRegistry.validationRequest, (validator, agent1, URI, HASH)),
                    "call data"
                );
            } else if (a.kind == VmSafe.AccountAccessKind.Extcodesize) {
                // Solidity checks that a call target has code before calling it; that's a read, not a call.
                assertTrue(a.account == address(registry) || a.account == address(identity), "extcodesize target");
            } else {
                ++staticCalls;
                assertEq(uint256(a.kind), uint256(VmSafe.AccountAccessKind.StaticCall), "only static reads");
                assertEq(a.account, address(identity), "static read target");
                assertEq(bytes4(a.data), IIdentityRegistry.ownerOf.selector, "static read selector");
            }
        }
        assertEq(calls, 1, "exactly one call");
        assertGt(staticCalls, 0, "reads ownerOf");
    }

    /// The compiled ABI has key management, request and the two immutables, and nothing else.
    function test_Abi_ExposesOnlyKeyManagementAndRequest() public view {
        string memory artifact = vm.readFile("out/AgentRequestForwarder.sol/AgentRequestForwarder.json");
        string[] memory got = vm.parseJsonKeys(artifact, ".methodIdentifiers");
        string[5] memory want = [
            "agentKeyOf(uint256)",
            "identityRegistry()",
            "request(address,uint256,string,bytes32)",
            "setAgentKey(uint256,address)",
            "validationRegistry()"
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

    /// Although it is the owner's operator, the forwarder has no function that moves or approves
    /// an agent: ERC-721 calls sent to it fail, from the key and from the owner.
    function test_CannotMoveTheAgent() public {
        bytes[] memory attempts = new bytes[](5);
        attempts[0] = abi.encodeCall(IERC721.transferFrom, (owner, key1, agent1));
        attempts[1] = abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", owner, key1, agent1);
        attempts[2] =
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256,bytes)", owner, key1, agent1, "");
        attempts[3] = abi.encodeCall(IERC721.approve, (key1, agent1));
        attempts[4] = abi.encodeCall(IERC721.setApprovalForAll, (key1, true));

        address[2] memory callers = [key1, owner];
        for (uint256 c; c < callers.length; ++c) {
            for (uint256 i; i < attempts.length; ++i) {
                vm.prank(callers[c]);
                (bool ok,) = address(forwarder).call(attempts[i]);
                assertFalse(ok);
            }
        }
        assertEq(identity.ownerOf(agent1), owner);
        assertEq(identity.getApproved(agent1), address(0));
        assertFalse(identity.isApprovedForAll(owner, key1));
    }

    function test_HoldsNoFunds() public {
        vm.deal(key1, 1 ether);
        vm.startPrank(key1);
        (bool sent,) = address(forwarder).call{value: 1}("");
        assertFalse(sent, "plain transfer");
        (bool requested,) = address(forwarder).call{value: 1}(
            abi.encodeCall(AgentRequestForwarder.request, (validator, agent1, URI, HASH))
        );
        assertFalse(requested, "payable request");
        vm.stopPrank();
        assertEq(address(forwarder).balance, 0);
    }

    function testFuzz_ArbitraryCalldataFromKey_NeverMovesTheAgent(bytes calldata data) public {
        vm.prank(key1);
        (bool ok,) = address(forwarder).call(data);
        ok; // a well-formed request may succeed; it must still not touch the agent's ownership or approvals
        assertEq(identity.ownerOf(agent1), owner);
        assertEq(identity.getApproved(agent1), address(0));
        assertFalse(identity.isApprovedForAll(owner, key1));
    }

    function testFuzz_Request_OnlyTheKey(address caller) public {
        vm.assume(caller != key1);
        vm.expectRevert(abi.encodeWithSelector(AgentRequestForwarder.NotAgentKey.selector, agent1, caller));
        vm.prank(caller);
        forwarder.request(validator, agent1, URI, HASH);
    }
}
