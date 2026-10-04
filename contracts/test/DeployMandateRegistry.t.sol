// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {DeployMandateRegistry} from "../script/DeployMandateRegistry.s.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

contract DeployMandateRegistryTest is Test {
    address internal constant FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant IDENTITY_REGISTRY_TESTNET = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    bytes32 internal constant RP_ID_HASH = sha256("attest8004.vercel.app");

    DeployMandateRegistry internal script;
    MockIdentityRegistry internal identity;

    function setUp() public {
        script = new DeployMandateRegistry();
        identity = new MockIdentityRegistry();
    }

    function test_Deploy_AtPredictedCreate2Address() public {
        address predicted = script.predictedAddress(address(identity));
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(MandateRegistry).creationCode, abi.encode(address(identity), RP_ID_HASH)));
        assertEq(predicted, vm.computeCreate2Address(script.SALT(), initCodeHash, FACTORY));
        assertEq(predicted.code.length, 0);

        MandateRegistry deployed = script.deploy(address(identity));

        assertEq(address(deployed), predicted);
        assertGt(predicted.code.length, 0);
    }

    function test_Deploy_IsIdempotent() public {
        MandateRegistry first = script.deploy(address(identity));

        vm.expectCall(FACTORY, bytes(""), 0);
        MandateRegistry second = script.deploy(address(identity));

        assertEq(address(second), address(first));
    }

    function test_Deploy_WiresBothImmutables() public {
        MandateRegistry deployed = script.deploy(address(identity));

        assertEq(address(deployed.identityRegistry()), address(identity));
        assertEq(deployed.rpIdHash(), RP_ID_HASH);
    }

    /// v2 is a new deployment: its own salt, and the rpId the passkeys are created on.
    function test_Constants_SaltV2AndRpId() public view {
        assertEq(script.SALT(), keccak256("attest8004.MandateRegistry.v2"));
        assertEq(script.RP_ID(), "attest8004.vercel.app");
        assertEq(script.RP_ID_HASH(), RP_ID_HASH);
    }

    /// deploy-testnet.sh compares Monad's eth_estimateGas for exactly this call with the limit
    /// before it broadcasts, so the plan must describe the transaction deploy() sends.
    function test_DeployPlan_MatchesTheDeployTransaction() public view {
        (address to, bytes memory data, uint256 gasLimit, address predicted) = script.deployPlan(10143);
        assertEq(to, FACTORY);
        assertEq(
            data,
            abi.encodePacked(
                script.SALT(), type(MandateRegistry).creationCode, abi.encode(IDENTITY_REGISTRY_TESTNET, RP_ID_HASH)
            )
        );
        assertEq(gasLimit, script.DEPLOY_GAS());
        assertEq(predicted, script.predictedAddress(IDENTITY_REGISTRY_TESTNET));
    }

    function test_ConfigFor_Testnet() public view {
        assertEq(script.configFor(10143), IDENTITY_REGISTRY_TESTNET);
    }

    /// No MandateRegistry is deployed on mainnet yet.
    function test_ConfigFor_RevertWhen_UnsupportedChain() public {
        vm.expectRevert(abi.encodeWithSelector(DeployMandateRegistry.UnsupportedChain.selector, 143));
        script.configFor(143);
        vm.expectRevert(abi.encodeWithSelector(DeployMandateRegistry.UnsupportedChain.selector, 1));
        script.deployPlan(1);
    }
}
