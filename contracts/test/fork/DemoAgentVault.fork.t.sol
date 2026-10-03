// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {AttestGate} from "../../src/AttestGate.sol";
import {DemoAgentVault} from "../../src/DemoAgentVault.sol";
import {Action} from "../../src/ActionHash.sol";
import {IValidationRegistry} from "../../src/interfaces/IValidationRegistry.sol";
import {DeployDemoAgentVault} from "../../script/DeployDemoAgentVault.s.sol";
import {IERC8004IdentityRegistry} from "./ValidationRegistry.fork.t.sol";

/// @notice DemoAgentVault against the live P1 ValidationRegistry and the canonical Identity
/// Registry, on a fork of Monad testnet (latest block). Skipped when MONAD_TESTNET_RPC_URL is unset.
contract DemoAgentVaultForkTest is Test {
    IERC8004IdentityRegistry internal constant IDENTITY =
        IERC8004IdentityRegistry(0x8004A818BFB912233c491871b3d84c89A494BD9e);
    IValidationRegistry internal constant REGISTRY = IValidationRegistry(0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f);
    string internal constant AGENT_URI = "data:application/json,{\"name\":\"attest8004-fork-test\"}";

    address internal alice = makeAddr("alice");
    address internal mallory = makeAddr("mallory");
    address internal validator = makeAddr("validator");
    address internal payee = makeAddr("payee");

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
    }

    function testFork_ValidatedActionExecutes() public {
        uint256 agentId = _register(alice);
        DemoAgentVault vault = _vault(agentId, validator);
        Action memory a = _transfer(agentId, keccak256("fork.1"));

        _request(alice, vault, a, validator, agentId);
        _respond(validator, vault.requestHashOf(a, validator));

        vault.execute(a);
        assertEq(payee.balance, 1 ether);
        assertTrue(vault.consumed(vault.actionHashOf(a)));
    }

    function testFork_SquattedHashFromOtherAgentReverts() public {
        uint256 agentId = _register(alice);
        uint256 malloryAgent = _register(mallory);
        DemoAgentVault vault = _vault(agentId, validator);
        Action memory a = _transfer(agentId, keccak256("fork.2"));
        bytes32 rh = vault.requestHashOf(a, validator);

        _request(mallory, vault, a, validator, malloryAgent);
        _respond(validator, rh);

        vm.expectRevert(abi.encodeWithSelector(AttestGate.AgentMismatch.selector, rh, agentId, malloryAgent));
        vault.execute(a);
    }

    /// The exact testnet configuration, deployed through the script (or found, once it is live),
    /// runs a validated action for its agent (demo agent 1984) as the agent's real owner, once
    /// both validators have answered with their own tag.
    function testFork_TestnetConfig_EndToEnd() public {
        DeployDemoAgentVault script = new DeployDemoAgentVault();
        (address registry, uint256 agentId, AttestGate.Requirement[] memory reqs) = script.configFor(10143);
        assertGt(registry.code.length, 0);
        assertEq(IValidationRegistry(registry).getIdentityRegistry(), address(IDENTITY));
        assertEq(reqs.length, 2);

        DemoAgentVault vault = script.deploy(registry, agentId, reqs);
        vm.deal(address(vault), address(vault).balance + 1 ether);
        Action memory a = _transfer(agentId, keccak256(abi.encode("fork.3", block.number)));

        address owner = IDENTITY.ownerOf(agentId);
        _request(owner, vault, a, reqs[0].validator, agentId);
        _respond(reqs[0].validator, vault.requestHashOf(a, reqs[0].validator), "mandate-v1");
        _request(owner, vault, a, reqs[1].validator, agentId);
        _respond(reqs[1].validator, vault.requestHashOf(a, reqs[1].validator), "risk-v1");

        uint256 before = payee.balance;
        vault.execute(a);
        assertEq(payee.balance, before + 1 ether);
    }

    function _respond(address v, bytes32 rh) internal {
        _respond(v, rh, "fork-test");
    }

    function _respond(address v, bytes32 rh, string memory tag) internal {
        vm.prank(v);
        REGISTRY.validationResponse(rh, 100, "", bytes32(0), tag);
    }

    function _register(address who) internal returns (uint256 agentId) {
        vm.prank(who);
        agentId = IDENTITY.register(AGENT_URI);
    }

    function _vault(uint256 agentId, address v) internal returns (DemoAgentVault vault) {
        AttestGate.Requirement[] memory reqs = new AttestGate.Requirement[](1);
        reqs[0] = AttestGate.Requirement(v, 100, keccak256(bytes("fork-test")));
        vault = new DemoAgentVault(address(REGISTRY), agentId, reqs);
        vm.deal(address(vault), 1 ether);
    }

    function _transfer(uint256 agentId, bytes32 salt) internal view returns (Action memory) {
        return Action({
            agentId: agentId,
            target: payee,
            value: 1 ether,
            data: "",
            deadline: uint64(block.timestamp + 1 hours),
            salt: salt
        });
    }

    function _request(address caller, DemoAgentVault vault, Action memory a, address v, uint256 recordedAgent)
        internal
    {
        bytes32 rh = vault.requestHashOf(a, v); // before the prank, which applies to the next call only
        vm.prank(caller);
        REGISTRY.validationRequest(v, recordedAgent, "data:application/json,{}", rh);
    }
}
