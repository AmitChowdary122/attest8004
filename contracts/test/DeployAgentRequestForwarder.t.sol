// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {AgentRequestForwarder} from "../src/AgentRequestForwarder.sol";
import {ValidationRegistry} from "../src/ValidationRegistry.sol";
import {DeployAgentRequestForwarder} from "../script/DeployAgentRequestForwarder.s.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

contract DeployAgentRequestForwarderTest is Test {
    address internal constant FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant REGISTRY_TESTNET = 0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f;

    DeployAgentRequestForwarder internal script;
    MockIdentityRegistry internal identity;
    ValidationRegistry internal registry;

    function setUp() public {
        script = new DeployAgentRequestForwarder();
        identity = new MockIdentityRegistry();
        registry = new ValidationRegistry(address(identity));
    }

    function test_Deploy_AtPredictedCreate2Address() public {
        address predicted = script.predictedAddress(address(registry));
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(AgentRequestForwarder).creationCode, abi.encode(address(registry))));
        assertEq(predicted, vm.computeCreate2Address(script.SALT(), initCodeHash, FACTORY));
        assertEq(predicted.code.length, 0);

        AgentRequestForwarder deployed = script.deploy(address(registry));

        assertEq(address(deployed), predicted);
        assertGt(predicted.code.length, 0);
    }

    function test_Deploy_IsIdempotent() public {
        AgentRequestForwarder first = script.deploy(address(registry));

        vm.expectCall(FACTORY, bytes(""), 0);
        AgentRequestForwarder second = script.deploy(address(registry));

        assertEq(address(second), address(first));
    }

    function test_Deploy_WiresRegistries() public {
        AgentRequestForwarder deployed = script.deploy(address(registry));

        assertEq(address(deployed.validationRegistry()), address(registry));
        assertEq(address(deployed.identityRegistry()), address(identity));
    }

    /// deploy-testnet.sh compares Monad's eth_estimateGas for exactly this call with the limit
    /// before it broadcasts, so the plan must describe the transaction deploy() sends.
    function test_DeployPlan_MatchesTheDeployTransaction() public view {
        (address to, bytes memory data, uint256 gasLimit, address predicted) = script.deployPlan(10143);
        assertEq(to, FACTORY);
        assertEq(
            data,
            abi.encodePacked(script.SALT(), type(AgentRequestForwarder).creationCode, abi.encode(REGISTRY_TESTNET))
        );
        assertEq(gasLimit, script.DEPLOY_GAS());
        assertEq(predicted, script.predictedAddress(REGISTRY_TESTNET));
    }

    function test_ConfigFor_Testnet() public view {
        assertEq(script.configFor(10143), REGISTRY_TESTNET);
    }

    /// No ValidationRegistry is deployed on mainnet yet.
    function test_ConfigFor_RevertWhen_UnsupportedChain() public {
        vm.expectRevert(abi.encodeWithSelector(DeployAgentRequestForwarder.UnsupportedChain.selector, 143));
        script.configFor(143);
        vm.expectRevert(abi.encodeWithSelector(DeployAgentRequestForwarder.UnsupportedChain.selector, 1));
        script.deployPlan(1);
    }
}
