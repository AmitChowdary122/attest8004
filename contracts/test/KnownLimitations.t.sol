// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {ValidationRegistry} from "../src/ValidationRegistry.sol";
import {AgentRequestForwarder} from "../src/AgentRequestForwarder.sol";
import {AttestGate} from "../src/AttestGate.sol";
import {DemoAgentVault} from "../src/DemoAgentVault.sol";
import {Action} from "../src/ActionHash.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {SimulationAwareRouter} from "./mocks/SimulationAwareRouter.sol";

/// @notice Known limitations, pinned so the docs can't drift from the contracts (P12 security review,
/// docs/security-review.md; docs/threat-model.md). Each test passes because the limitation is real.
/// Adopted from the independent auditor's proofs of concept.
///
/// AUD-01: with a two-validator gate, the first request's ValidationRequest event carries the whole action in its
/// requestURI, so anyone who owns any agent can compute the second validator's requestHash from the landed log and
/// claim it first, without seeing any pending transaction. The SDK sends an action's requests back to back, before
/// awaiting any receipt, so they normally share a block; these tests pin what the contracts allow when they don't.
///
/// AUD-04: risk-v1's FUNDS_FORWARDED evidence comes from a simulation the target can detect.
contract KnownLimitationsTest is Test {
    MockIdentityRegistry internal identity;
    ValidationRegistry internal registry;
    AgentRequestForwarder internal forwarder;
    DemoAgentVault internal vault;

    address internal owner = makeAddr("owner");
    address internal hotKey = makeAddr("hotKey");
    address internal mallory = makeAddr("mallory");
    address internal validatorA = makeAddr("validatorA");
    address internal validatorB = makeAddr("validatorB");
    address internal payee = makeAddr("payee");
    uint256 internal agentId;
    uint256 internal malloryAgent;

    function setUp() public {
        vm.warp(1_790_000_000);
        identity = new MockIdentityRegistry();
        registry = new ValidationRegistry(address(identity));
        forwarder = new AgentRequestForwarder(address(registry));
        vm.startPrank(owner);
        agentId = identity.register();
        identity.approve(address(forwarder), agentId);
        forwarder.setAgentKey(agentId, hotKey);
        vm.stopPrank();
        vm.prank(mallory);
        malloryAgent = identity.register();

        AttestGate.Requirement[] memory reqs = new AttestGate.Requirement[](2);
        reqs[0] = AttestGate.Requirement(validatorA, 100, keccak256("mandate-v1"));
        reqs[1] = AttestGate.Requirement(validatorB, 80, keccak256("risk-v1"));
        vault = new DemoAgentVault(address(registry), agentId, reqs);
        vm.deal(address(vault), 1 ether);
    }

    function _action(bytes32 salt) internal view returns (Action memory) {
        return Action(agentId, payee, 0.001 ether, "", uint64(block.timestamp + 1 hours), salt);
    }

    function test_Limitation_AUD01_SecondHashSquattedFromTheLandedFirstRequest() public {
        Action memory a = _action(keccak256("salt-1"));

        // 1. The hot key's first request lands (validator A). Its URI is public and holds every action field.
        bytes32 rhA = vault.requestHashOf(a, validatorA);
        vm.prank(hotKey);
        forwarder.request(validatorA, agentId, "data:application/json,<the action JSON>", rhA);

        // 2. Mallory reads the action from that log and claims B's hash for her own agent before
        //    the hot key's second transaction lands. No mempool access is needed.
        bytes32 rhB = vault.requestHashOf(a, validatorB);
        vm.prank(mallory);
        registry.validationRequest(validatorB, malloryAgent, "data:application/json,{}", rhB);

        // 3. The agent's request to B now reverts, so B can never answer for this action.
        vm.prank(hotKey);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.RequestExists.selector, rhB));
        forwarder.request(validatorB, agentId, "data:application/json,<the action JSON>", rhB);

        // 4. Even with A's pass, the gate refuses: the stored record for rhB is Mallory's agent.
        vm.prank(validatorA);
        registry.validationResponse(rhA, 100, "", keccak256("e"), "mandate-v1");
        vm.expectRevert(abi.encodeWithSelector(AttestGate.AgentMismatch.selector, rhB, agentId, malloryAgent));
        vault.execute(a);
    }

    /// The agent's only recourse is a new salt, and the same move works again every time.
    function test_Limitation_AUD01_EveryRetryCanBeSquatted() public {
        for (uint256 i; i < 5; ++i) {
            Action memory a = _action(keccak256(abi.encode("retry", i)));
            bytes32 rhA = vault.requestHashOf(a, validatorA);
            vm.prank(hotKey);
            forwarder.request(validatorA, agentId, "data:application/json,<json>", rhA);
            bytes32 rhB = vault.requestHashOf(a, validatorB);
            vm.prank(mallory);
            registry.validationRequest(validatorB, malloryAgent, "x", rhB);
            vm.prank(hotKey);
            vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.RequestExists.selector, rhB));
            forwarder.request(validatorB, agentId, "data:application/json,<json>", rhB);
        }
    }

    function test_Limitation_AUD04_TargetHidesForwardingFromTheValidatorsSimulation() public {
        SimulationAwareRouter router = new SimulationAwareRouter(payable(payee));
        Action memory a =
            Action(agentId, address(router), 0.001 ether, "", uint64(block.timestamp + 1 hours), bytes32("s"));

        // What the validators trace at P: from = the gate, so tx.origin == msg.sender; nothing is forwarded.
        vm.prank(address(vault), address(vault));
        (bool ok,) = address(router).call{value: 0.001 ether}("");
        assertTrue(ok);
        assertEq(payee.balance, 0, "the simulation shows no value flow past the target");

        // Both validators pass it, and anyone submits the real execute, which forwards to the sink.
        bytes32 rhA = vault.requestHashOf(a, validatorA);
        bytes32 rhB = vault.requestHashOf(a, validatorB);
        vm.startPrank(hotKey);
        forwarder.request(validatorA, agentId, "x", rhA);
        forwarder.request(validatorB, agentId, "x", rhB);
        vm.stopPrank();
        vm.prank(validatorA);
        registry.validationResponse(rhA, 100, "", keccak256("a"), "mandate-v1");
        vm.prank(validatorB);
        registry.validationResponse(rhB, 100, "", keccak256("b"), "risk-v1");
        address submitter = makeAddr("submitter");
        vm.prank(submitter, submitter);
        vault.execute(a);
        assertEq(payee.balance, 0.001 ether, "the real execution forwards the payment");
    }
}
