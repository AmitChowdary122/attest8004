// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {AttestGate} from "../src/AttestGate.sol";
import {DemoAgentVault} from "../src/DemoAgentVault.sol";
import {ValidationRegistry} from "../src/ValidationRegistry.sol";
import {DeployDemoAgentVault} from "../script/DeployDemoAgentVault.s.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

contract DeployDemoAgentVaultTest is Test {
    address internal constant FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant REGISTRY_TESTNET = 0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f;
    address internal constant VALIDATOR_A = 0xa62DaB21E0C0F57e94B3ed6e675F214199989e92;

    DeployDemoAgentVault internal script;
    ValidationRegistry internal registry;

    function setUp() public {
        script = new DeployDemoAgentVault();
        registry = new ValidationRegistry(address(new MockIdentityRegistry()));
    }

    function _reqs() internal pure returns (AttestGate.Requirement[] memory r) {
        r = new AttestGate.Requirement[](1);
        r[0] = AttestGate.Requirement(VALIDATOR_A, 100);
    }

    function test_Deploy_AtPredictedCreate2Address() public {
        address predicted = script.predictedAddress(address(registry), 1982, _reqs());
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(DemoAgentVault).creationCode, abi.encode(address(registry), uint256(1982), _reqs()))
        );
        assertEq(predicted, vm.computeCreate2Address(script.SALT(), initCodeHash, FACTORY));
        assertEq(predicted.code.length, 0);

        DemoAgentVault deployed = script.deploy(address(registry), 1982, _reqs());

        assertEq(address(deployed), predicted);
        assertGt(predicted.code.length, 0);
    }

    function test_Deploy_IsIdempotent() public {
        DemoAgentVault first = script.deploy(address(registry), 1982, _reqs());

        vm.expectCall(FACTORY, bytes(""), 0);
        DemoAgentVault second = script.deploy(address(registry), 1982, _reqs());

        assertEq(address(second), address(first));
    }

    function test_Deploy_WiresConfig() public {
        DemoAgentVault deployed = script.deploy(address(registry), 1982, _reqs());

        assertEq(address(deployed.validationRegistry()), address(registry));
        assertEq(deployed.agentId(), 1982);
        AttestGate.Requirement[] memory got = deployed.requirements();
        assertEq(got.length, 1);
        assertEq(got[0].validator, VALIDATOR_A);
        assertEq(got[0].minScore, 100);
    }

    /// deploy-testnet.sh compares Monad's eth_estimateGas for exactly this call with the limit
    /// before it broadcasts, so the plan must describe the transaction deploy() sends.
    function test_DeployPlan_MatchesTheDeployTransaction() public view {
        (address to, bytes memory data, uint256 gasLimit, address predicted) = script.deployPlan(10143);
        assertEq(to, FACTORY);
        assertEq(
            data,
            abi.encodePacked(
                script.SALT(), type(DemoAgentVault).creationCode, abi.encode(REGISTRY_TESTNET, uint256(1982), _reqs())
            )
        );
        assertEq(gasLimit, script.DEPLOY_GAS());
        assertEq(predicted, script.predictedAddress(REGISTRY_TESTNET, 1982, _reqs()));
    }

    /// The P2 testnet vault: agent 1982, validator A (mandate-v1) at 100 only, until P5.
    function test_ConfigFor_Testnet() public view {
        (address reg, uint256 agentId, AttestGate.Requirement[] memory reqs) = script.configFor(10143);
        assertEq(reg, REGISTRY_TESTNET);
        assertEq(agentId, 1982);
        assertEq(reqs.length, 1);
        assertEq(reqs[0].validator, VALIDATOR_A);
        assertEq(reqs[0].minScore, 100);
    }

    /// No ValidationRegistry is deployed on mainnet yet.
    function test_ConfigFor_RevertWhen_UnsupportedChain() public {
        vm.expectRevert(abi.encodeWithSelector(DeployDemoAgentVault.UnsupportedChain.selector, 143));
        script.configFor(143);
        vm.expectRevert(abi.encodeWithSelector(DeployDemoAgentVault.UnsupportedChain.selector, 1));
        script.deployPlan(1);
    }
}
