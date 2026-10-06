// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {ValidationRegistry} from "../src/ValidationRegistry.sol";
import {AttestGate} from "../src/AttestGate.sol";
import {DemoAgentVault} from "../src/DemoAgentVault.sol";
import {Action} from "../src/ActionHash.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

/// @notice Drives the real registry and a two-validator vault (A = 100 under mandate-v1, B >= 80 under risk-v1) with
/// random requests, responses (any score, right or wrong tag), squats by another agent, time jumps and executes from
/// random submitters. Ghost state records what the gate should have allowed (P12 coverage gap 3).
contract VaultHandler is Test {
    ValidationRegistry internal immutable registry;
    DemoAgentVault internal immutable vault;
    address internal immutable owner;
    address internal immutable attacker;
    uint256 internal immutable agentId;
    uint256 internal immutable attackerAgentId;
    address internal immutable validatorA;
    address internal immutable validatorB;

    Action[] internal actions;
    mapping(bytes32 actionHash => uint256) public executions;
    uint256 public paid;
    /// An execute that succeeded although the verdicts on record did not pass: must stay 0.
    uint256 public unvalidatedSuccesses;

    constructor(
        ValidationRegistry registry_,
        DemoAgentVault vault_,
        address owner_,
        address attacker_,
        uint256 agentId_,
        uint256 attackerAgentId_,
        address validatorA_,
        address validatorB_
    ) {
        registry = registry_;
        vault = vault_;
        owner = owner_;
        attacker = attacker_;
        agentId = agentId_;
        attackerAgentId = attackerAgentId_;
        validatorA = validatorA_;
        validatorB = validatorB_;
    }

    function actionCount() external view returns (uint256) {
        return actions.length;
    }

    function actionAt(uint256 i) external view returns (Action memory) {
        return actions[i];
    }

    function newAction(uint96 value, uint8 payeeSeed, uint16 ttl, bytes32 salt) external {
        address payee = address(uint160(0xBEEF00 + (payeeSeed % 4)));
        actions.push(
            Action(agentId, payee, bound(value, 0, 0.5 ether), "", uint64(block.timestamp + bound(ttl, 1, 3600)), salt)
        );
    }

    function request(uint256 i, bool forB) external {
        if (actions.length == 0) return;
        Action memory a = actions[i % actions.length];
        address v = forB ? validatorB : validatorA;
        bytes32 rh = vault.requestHashOf(a, v);
        vm.prank(owner);
        try registry.validationRequest(v, agentId, "data:application/json,{}", rh) {} catch {}
    }

    /// Another agent claims a requestHash first, naming the right or a wrong validator.
    function squat(uint256 i, bool forB, bool nameRightValidator) external {
        if (actions.length == 0) return;
        Action memory a = actions[i % actions.length];
        bytes32 rh = vault.requestHashOf(a, forB ? validatorB : validatorA);
        address named = nameRightValidator ? (forB ? validatorB : validatorA) : attacker;
        vm.prank(attacker);
        try registry.validationRequest(named, attackerAgentId, "x", rh) {} catch {}
    }

    function respond(uint256 i, bool forB, uint8 score, bool rightTag) external {
        if (actions.length == 0) return;
        Action memory a = actions[i % actions.length];
        address v = forB ? validatorB : validatorA;
        bytes32 rh = vault.requestHashOf(a, v);
        string memory tag = rightTag == forB ? "risk-v1" : "mandate-v1";
        vm.prank(v);
        try registry.validationResponse(rh, uint8(bound(score, 0, 100)), "", keccak256("e"), tag) {} catch {}
    }

    /// Both validators request and pass the action at once, so double executes and replays are actually reached.
    function approveBoth(uint256 i) external {
        if (actions.length == 0) return;
        Action memory a = actions[i % actions.length];
        bytes32 rhA = vault.requestHashOf(a, validatorA);
        bytes32 rhB = vault.requestHashOf(a, validatorB);
        vm.startPrank(owner);
        try registry.validationRequest(validatorA, agentId, "data:application/json,{}", rhA) {} catch {}
        try registry.validationRequest(validatorB, agentId, "data:application/json,{}", rhB) {} catch {}
        vm.stopPrank();
        vm.prank(validatorA);
        try registry.validationResponse(rhA, 100, "", keccak256("a"), "mandate-v1") {} catch {}
        vm.prank(validatorB);
        try registry.validationResponse(rhB, 90, "", keccak256("b"), "risk-v1") {} catch {}
    }

    function warp(uint16 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 2000));
    }

    function execute(uint256 i, address submitter) external {
        if (actions.length == 0) return;
        Action memory a = actions[i % actions.length];
        bytes32 ah = vault.actionHashOf(a);
        bool shouldPass = !vault.consumed(ah) && block.timestamp <= a.deadline
            && _passes(a, validatorA, 100, "mandate-v1") && _passes(a, validatorB, 80, "risk-v1");
        vm.prank(submitter);
        try vault.execute(a) {
            executions[ah] += 1;
            paid += a.value;
            if (!shouldPass) unvalidatedSuccesses += 1;
        } catch {}
    }

    function _passes(Action memory a, address v, uint8 minScore, string memory tag) internal view returns (bool) {
        try registry.getValidationStatus(vault.requestHashOf(a, v)) returns (
            address storedValidator, uint256 storedAgent, uint8 response, bytes32, string memory storedTag, uint256
        ) {
            return storedValidator == v && storedAgent == agentId && response >= minScore
                && keccak256(bytes(storedTag)) == keccak256(bytes(tag));
        } catch {
            return false;
        }
    }
}

contract AttestGateInvariantTest is Test {
    MockIdentityRegistry internal identity;
    ValidationRegistry internal registry;
    DemoAgentVault internal vault;
    VaultHandler internal handler;
    uint256 internal constant START_BALANCE = 100 ether;

    function setUp() public {
        vm.warp(1_790_000_000);
        identity = new MockIdentityRegistry();
        registry = new ValidationRegistry(address(identity));
        address owner = makeAddr("owner");
        address attacker = makeAddr("attacker");
        vm.prank(owner);
        uint256 agentId = identity.register();
        vm.prank(attacker);
        uint256 attackerAgentId = identity.register();
        address validatorA = makeAddr("validatorA");
        address validatorB = makeAddr("validatorB");
        AttestGate.Requirement[] memory reqs = new AttestGate.Requirement[](2);
        reqs[0] = AttestGate.Requirement(validatorA, 100, keccak256("mandate-v1"));
        reqs[1] = AttestGate.Requirement(validatorB, 80, keccak256("risk-v1"));
        vault = new DemoAgentVault(address(registry), agentId, reqs);
        vm.deal(address(vault), START_BALANCE);
        handler = new VaultHandler(registry, vault, owner, attacker, agentId, attackerAgentId, validatorA, validatorB);
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 64
    /// forge-config: ci.invariant.runs = 256
    /// forge-config: ci.invariant.depth = 64
    function invariant_EachActionExecutesAtMostOnce() public view {
        for (uint256 i; i < handler.actionCount(); ++i) {
            assertLe(handler.executions(vault.actionHashOf(handler.actionAt(i))), 1);
        }
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 64
    /// forge-config: ci.invariant.runs = 256
    /// forge-config: ci.invariant.depth = 64
    function invariant_MonLeavesOnlyThroughValidatedExecutes() public view {
        assertEq(handler.unvalidatedSuccesses(), 0, "an execute passed without both verdicts");
        assertEq(address(vault).balance, START_BALANCE - handler.paid(), "MON left the vault another way");
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 64
    /// forge-config: ci.invariant.runs = 256
    /// forge-config: ci.invariant.depth = 64
    function invariant_ConsumedMeansExecutedOnce() public view {
        for (uint256 i; i < handler.actionCount(); ++i) {
            bytes32 ah = vault.actionHashOf(handler.actionAt(i));
            assertEq(vault.consumed(ah), handler.executions(ah) == 1);
        }
    }
}
