// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {CreValidator} from "../src/CreValidator.sol";
import {DeployCreValidator} from "../script/DeployCreValidator.s.sol";

contract DeployCreValidatorTest is Test {
    address internal constant FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    DeployCreValidator internal script;

    function setUp() public {
        script = new DeployCreValidator();
    }

    function test_Deploy_AtPredictedCreate2Address() public {
        address predicted = script.predictedAddress();
        assertEq(predicted, vm.computeCreate2Address(script.SALT(), keccak256(script.initCode()), FACTORY));
        assertEq(predicted.code.length, 0);

        CreValidator deployed = script.deploy();

        assertEq(address(deployed), predicted);
        assertGt(predicted.code.length, 0);
    }

    /// The deployed contract carries exactly the script's constructor arguments: the testnet mock
    /// forwarder, the live registry, the simulator's placeholder owner and our workflow's name.
    function test_InitCode_CarriesArgs() public {
        CreValidator deployed = script.deploy();
        assertEq(deployed.forwarder(), 0xB9F79d863261869B234c481D1f9A7af84AeAd192);
        assertEq(address(deployed.registry()), 0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f);
        assertEq(deployed.workflowOwner(), 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa);
        assertEq(deployed.workflowName(), bytes10(0x36386365303833636635));
    }

    function test_Deploy_IsIdempotent() public {
        CreValidator first = script.deploy();
        vm.expectCall(FACTORY, bytes(""), 0);
        CreValidator second = script.deploy();
        assertEq(address(second), address(first));
    }

    /// CRE encodes a workflow name as the ASCII of the first 10 hex characters of sha256(name).
    /// Derived here independently of the script's literal (the workflow's bun test derives it a
    /// second time, from workflow.yaml's name).
    function test_WorkflowName_IsSha256HexPrefix() public view {
        bytes32 digest = sha256(bytes("attest8004-validator-c"));
        bytes memory hexDigits = "0123456789abcdef";
        bytes memory ascii = new bytes(10);
        for (uint256 i; i < 5; ++i) {
            ascii[2 * i] = hexDigits[uint8(digest[i]) >> 4];
            ascii[2 * i + 1] = hexDigits[uint8(digest[i]) & 0x0f];
        }
        assertEq(script.WORKFLOW_NAME(), bytes10(ascii));
    }

    function test_DeployPlan_MatchesTheDeployTransaction() public view {
        (address to, bytes memory data, uint256 gasLimit, address predicted) = script.deployPlan(10143);
        assertEq(to, FACTORY);
        assertEq(data, abi.encodePacked(script.SALT(), script.initCode()));
        assertEq(gasLimit, script.DEPLOY_GAS());
        assertEq(predicted, script.predictedAddress());
    }

    function test_DeployPlan_RevertWhen_UnsupportedChain() public {
        vm.expectRevert(abi.encodeWithSelector(DeployCreValidator.UnsupportedChain.selector, 143));
        script.deployPlan(143);
    }
}
