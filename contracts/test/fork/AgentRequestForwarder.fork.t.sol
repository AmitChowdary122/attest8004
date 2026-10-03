// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {AgentRequestForwarder} from "../../src/AgentRequestForwarder.sol";
import {IValidationRegistry} from "../../src/interfaces/IValidationRegistry.sol";
import {DeployAgentRequestForwarder} from "../../script/DeployAgentRequestForwarder.s.sol";
import {IERC8004IdentityRegistry} from "./ValidationRegistry.fork.t.sol";

/// @notice AgentRequestForwarder against the live P1 ValidationRegistry and the canonical Identity
/// Registry, on a fork of Monad testnet (latest block). Skipped when MONAD_TESTNET_RPC_URL is unset.
contract AgentRequestForwarderForkTest is Test {
    IERC8004IdentityRegistry internal constant IDENTITY =
        IERC8004IdentityRegistry(0x8004A818BFB912233c491871b3d84c89A494BD9e);
    IValidationRegistry internal constant REGISTRY = IValidationRegistry(0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f);
    string internal constant AGENT_URI = "data:application/json,{\"name\":\"attest8004-fork-test\"}";

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal hotKey = makeAddr("hotKey");
    address internal validator = makeAddr("validator");

    AgentRequestForwarder internal forwarder;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        // The testnet configuration, deployed through the script (or found, once it is live).
        DeployAgentRequestForwarder script = new DeployAgentRequestForwarder();
        forwarder = script.deploy(script.configFor(10143));
    }

    function testFork_KeyRequestsThroughForwarder() public {
        uint256 agentId = _registerWithKey(alice, hotKey);
        bytes32 rh = keccak256(abi.encode("fork.forwarder.1", block.number));

        vm.prank(hotKey);
        forwarder.request(validator, agentId, "data:application/json,{}", rh);

        (address v, uint256 id,,,,) = REGISTRY.getValidationStatus(rh);
        assertEq(v, validator);
        assertEq(id, agentId);
    }

    function testFork_StaleKeyAfterTransfer() public {
        uint256 agentId = _registerWithKey(alice, hotKey);
        vm.prank(alice);
        IDENTITY.transferFrom(alice, bob, agentId);
        vm.prank(bob);
        IDENTITY.setApprovalForAll(address(forwarder), true);

        vm.expectRevert(abi.encodeWithSelector(AgentRequestForwarder.StaleAgentKey.selector, agentId, alice, bob));
        vm.prank(hotKey);
        forwarder.request(validator, agentId, "data:application/json,{}", keccak256("fork.forwarder.2"));
    }

    function testFork_TestnetConfigPointsAtLiveRegistry() public view {
        assertEq(address(forwarder.validationRegistry()), address(REGISTRY));
        assertEq(address(forwarder.identityRegistry()), address(IDENTITY));
        assertGt(address(REGISTRY).code.length, 0);
    }

    function _registerWithKey(address owner, address key) internal returns (uint256 agentId) {
        vm.startPrank(owner);
        agentId = IDENTITY.register(AGENT_URI);
        IDENTITY.setApprovalForAll(address(forwarder), true);
        forwarder.setAgentKey(agentId, key);
        vm.stopPrank();
    }
}
