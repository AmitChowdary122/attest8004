// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {ValidationRegistry} from "../src/ValidationRegistry.sol";
import {DeployValidationRegistry} from "../script/DeployValidationRegistry.s.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

contract DeployValidationRegistryTest is Test {
    address internal constant FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant IDENTITY_TESTNET = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant IDENTITY_MAINNET = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;

    DeployValidationRegistry internal script;
    MockIdentityRegistry internal identity;

    function setUp() public {
        script = new DeployValidationRegistry();
        identity = new MockIdentityRegistry();
    }

    function test_Deploy_AtPredictedCreate2Address() public {
        address predicted = script.predictedAddress(address(identity));
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(ValidationRegistry).creationCode, abi.encode(address(identity))));
        assertEq(predicted, vm.computeCreate2Address(script.SALT(), initCodeHash, FACTORY));
        assertEq(predicted.code.length, 0);

        ValidationRegistry deployed = script.deploy(address(identity));

        assertEq(address(deployed), predicted);
        assertGt(predicted.code.length, 0);
    }

    function test_Deploy_IsIdempotent() public {
        ValidationRegistry first = script.deploy(address(identity));

        vm.expectCall(FACTORY, bytes(""), 0);
        ValidationRegistry second = script.deploy(address(identity));

        assertEq(address(second), address(first));
    }

    function test_Deploy_PointsAtIdentityRegistry() public {
        ValidationRegistry deployed = script.deploy(address(identity));
        assertEq(deployed.getIdentityRegistry(), address(identity));
    }

    /// The init code includes the constructor argument, so each chain's registry has its own address.
    function test_PredictedAddress_DiffersPerIdentityRegistry() public view {
        assertTrue(script.predictedAddress(IDENTITY_TESTNET) != script.predictedAddress(IDENTITY_MAINNET));
    }

    /// deploy-testnet.sh compares Monad's eth_estimateGas for exactly this call with the limit
    /// before it broadcasts, so the plan must describe the transaction deploy() sends.
    function test_DeployPlan_MatchesTheDeployTransaction() public view {
        (address to, bytes memory data, uint256 gasLimit, address predicted) = script.deployPlan(10143);
        assertEq(to, FACTORY);
        assertEq(
            data, abi.encodePacked(script.SALT(), type(ValidationRegistry).creationCode, abi.encode(IDENTITY_TESTNET))
        );
        assertEq(gasLimit, script.DEPLOY_GAS());
        assertEq(predicted, script.predictedAddress(IDENTITY_TESTNET));
    }

    function test_DeployPlan_RevertWhen_UnknownChain() public {
        vm.expectRevert(abi.encodeWithSelector(DeployValidationRegistry.UnsupportedChain.selector, 1));
        script.deployPlan(1);
    }

    function test_IdentityRegistryFor_KnownChains() public view {
        assertEq(script.identityRegistryFor(10143), IDENTITY_TESTNET);
        assertEq(script.identityRegistryFor(143), IDENTITY_MAINNET);
    }

    function test_IdentityRegistryFor_RevertWhen_UnknownChain() public {
        vm.expectRevert(abi.encodeWithSelector(DeployValidationRegistry.UnsupportedChain.selector, 1));
        script.identityRegistryFor(1);
    }
}
