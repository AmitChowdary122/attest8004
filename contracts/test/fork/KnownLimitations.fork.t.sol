// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {AttestGate} from "../../src/AttestGate.sol";
import {DemoAgentVault} from "../../src/DemoAgentVault.sol";
import {AgentRequestForwarder} from "../../src/AgentRequestForwarder.sol";
import {FindingsBoard} from "../../src/FindingsBoard.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";
import {ValidationRegistry} from "../../src/ValidationRegistry.sol";
import {Action} from "../../src/ActionHash.sol";
import {IERC8004IdentityRegistry} from "./ValidationRegistry.fork.t.sol";

/// @notice Known limitations, pinned against the contracts deployed on Monad testnet (docs/deployments.md) on a local
/// fork: nothing is broadcast (P12 security review; adopted from the independent auditor's proofs of concept).
/// Skipped when MONAD_TESTNET_RPC_URL is unset.
contract KnownLimitationsForkTest is Test {
    IERC8004IdentityRegistry internal constant IDENTITY =
        IERC8004IdentityRegistry(0x8004A818BFB912233c491871b3d84c89A494BD9e);
    ValidationRegistry internal constant REGISTRY = ValidationRegistry(0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f);
    AgentRequestForwarder internal constant FORWARDER =
        AgentRequestForwarder(0x1451F3C36545b191d3642f759D59f21DcFD657B2);
    DemoAgentVault internal constant VAULT = DemoAgentVault(payable(0x12fAb3E3cA810Cc44bD9f537613a230a2be8D614));
    MandateRegistry internal constant MANDATES = MandateRegistry(0x2Ee5f78149762DE630c6bFF8CD81166010D0454B);
    FindingsBoard internal constant BOARD = FindingsBoard(0xa7d52B3B08FAB0cd0527c6242ca678f9Feee6a1c);
    address internal constant VALIDATOR_A = 0xa62DaB21E0C0F57e94B3ed6e675F214199989e92;
    address internal constant VALIDATOR_B = 0x780df855b48AeC7A3907433b0b5984A2fe5dca5E;
    uint256 internal constant AGENT = 1984;

    address internal mallory = makeAddr("mallory");
    address internal rogueValidator = makeAddr("rogueValidator");
    address internal hotKey;
    address internal owner;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        (hotKey,) = FORWARDER.agentKeyOf(AGENT);
        owner = IDENTITY.ownerOf(AGENT);
    }

    function _action(address target, bytes32 salt) internal view returns (Action memory) {
        return Action(AGENT, target, 0.001 ether, "", uint64(block.timestamp + 30 minutes), salt);
    }

    /// AUD-01 on the live vault: B's requestHash, computed from A's landed request, is claimed by a fresh agent;
    /// agent 1984's hot key can then never request B for that action, and the live vault refuses it.
    function testFork_Limitation_AUD01_LiveVaultSecondRequestSquat() public {
        Action memory a = _action(owner, keccak256(abi.encode("aud-01", block.number)));
        bytes32 rhA = VAULT.requestHashOf(a, VALIDATOR_A);
        vm.prank(hotKey);
        FORWARDER.request(VALIDATOR_A, AGENT, "data:application/json,<action JSON>", rhA);

        vm.prank(mallory);
        uint256 malloryAgent = IDENTITY.register("data:application/json,{}");
        bytes32 rhB = VAULT.requestHashOf(a, VALIDATOR_B);
        vm.prank(mallory);
        REGISTRY.validationRequest(VALIDATOR_B, malloryAgent, "x", rhB);

        vm.prank(hotKey);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.RequestExists.selector, rhB));
        FORWARDER.request(VALIDATOR_B, AGENT, "data:application/json,<action JSON>", rhB);

        vm.prank(VALIDATOR_A);
        REGISTRY.validationResponse(rhA, 100, "", keccak256("e"), "mandate-v1");
        vm.expectRevert(abi.encodeWithSelector(AttestGate.AgentMismatch.selector, rhB, AGENT, malloryAgent));
        VAULT.execute(a);
    }

    /// AUD-03 on the live contracts: the agent's own hot key (or any operator of 1984) names an arbitrary validator,
    /// which answers and posts to FindingsBoard. The registry then names that validator and agent 1984, which is
    /// exactly the /inbox trust rule, so the post passes it (anyone can seal to the public inbox key). /inbox therefore
    /// lists Attest8004's own validators first and labels any other validator's reports as such (AUD-03's fix).
    function testFork_Limitation_AUD03_HotKeyNamesItsOwnValidatorAndPosts() public {
        bytes32 rh = keccak256(abi.encode("aud-03", block.number));
        vm.prank(hotKey);
        FORWARDER.request(rogueValidator, AGENT, "data:application/json,{}", rh);
        vm.prank(rogueValidator);
        REGISTRY.validationResponse(rh, 100, "data:,", keccak256("anything"), "mandate-v1");
        vm.prank(rogueValidator);
        BOARD.post(rh, AGENT, hex"01");

        (address v, uint256 id, uint8 score,, string memory tag,) = REGISTRY.getValidationStatus(rh);
        assertEq(v, rogueValidator); // isTrustedPost: post.validator == status.validator
        assertEq(id, AGENT); //          and post.agentId == status.agentId
        assertEq(score, 100);
        assertEq(tag, "mandate-v1"); // shown as "<address>: mandate-v1, score 100"
        bytes32[] memory all = REGISTRY.getAgentValidations(AGENT);
        assertEq(all[all.length - 1], rh); // the newest entry of the agent's list
    }

    /// AUD-06 on the live contracts: an action both validators passed still executes after the owner pulls the
    /// "panic button" (revokeMandate). The gate never consults MandateRegistry.
    function testFork_Limitation_AUD06_ValidatedActionRunsAfterRevoke() public {
        Action memory a = _action(owner, keccak256(abi.encode("aud-06", block.number)));
        bytes32 rhA = VAULT.requestHashOf(a, VALIDATOR_A);
        bytes32 rhB = VAULT.requestHashOf(a, VALIDATOR_B);
        vm.startPrank(hotKey);
        FORWARDER.request(VALIDATOR_A, AGENT, "data:application/json,{}", rhA);
        FORWARDER.request(VALIDATOR_B, AGENT, "data:application/json,{}", rhB);
        vm.stopPrank();
        vm.prank(VALIDATOR_A);
        REGISTRY.validationResponse(rhA, 100, "", keccak256("a"), "mandate-v1");
        vm.prank(VALIDATOR_B);
        REGISTRY.validationResponse(rhB, 100, "", keccak256("b"), "risk-v1");

        vm.prank(owner);
        MANDATES.revokeMandate(AGENT);
        (, bytes32 mandateHash,,) = MANDATES.getMandate(AGENT);
        assertEq(mandateHash, bytes32(0));

        uint256 before = owner.balance;
        vm.prank(mallory); // anyone may submit it
        VAULT.execute(a);
        assertEq(owner.balance, before + 0.001 ether);
    }
}
