// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {DemoPassThrough} from "../src/DemoPassThrough.sol";
import {DeployDemoPassThrough} from "../script/DeployDemoPassThrough.s.sol";

contract DeployDemoPassThroughTest is Test {
    address internal constant FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// `address(uint160(uint256(keccak256("attest8004.demo.sink"))))`, pinned independently:
    /// `cast keccak "attest8004.demo.sink"` on 4 Oct 2026, last 20 bytes, `cast
    /// to-check-sum-address`.
    address payable internal constant SINK = payable(0xC8702cA01e934f0568ea43B354C17ec7749d313f);

    DeployDemoPassThrough internal script;

    function setUp() public {
        script = new DeployDemoPassThrough();
    }

    function test_Deploy_AtPredictedCreate2Address() public {
        address predicted = script.predictedAddress(SINK);
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(DemoPassThrough).creationCode, abi.encode(SINK)));
        assertEq(predicted, vm.computeCreate2Address(script.SALT(), initCodeHash, FACTORY));
        assertEq(predicted.code.length, 0);

        DemoPassThrough deployed = script.deploy(SINK);

        assertEq(address(deployed), predicted);
        assertGt(predicted.code.length, 0);
        assertEq(deployed.sink(), SINK);
    }

    function test_Deploy_IsIdempotent() public {
        DemoPassThrough first = script.deploy(SINK);

        vm.expectCall(FACTORY, bytes(""), 0);
        DemoPassThrough second = script.deploy(SINK);

        assertEq(address(second), address(first));
    }

    /// deploy-testnet.sh compares Monad's eth_estimateGas for exactly this call with the limit
    /// before it broadcasts, so the plan must describe the transaction deploy() sends.
    function test_DeployPlan_MatchesTheDeployTransaction() public view {
        (address to, bytes memory data, uint256 gasLimit, address predicted) = script.deployPlan(10143);
        assertEq(to, FACTORY);
        assertEq(data, abi.encodePacked(script.SALT(), type(DemoPassThrough).creationCode, abi.encode(SINK)));
        assertEq(gasLimit, script.DEPLOY_GAS());
        assertEq(predicted, script.predictedAddress(SINK));
    }

    /// Pins `SINK` independently of the script's own literal (see `SINK` above): both must agree
    /// with the derived expression TypeScript computes the same way (slice(keccak256(toBytes(...
    /// ))), 12) -> getAddress).
    function test_ConfigFor_Testnet() public view {
        address payable sink = script.configFor(10143);
        assertEq(sink, SINK);
        assertEq(sink, payable(address(uint160(uint256(keccak256("attest8004.demo.sink"))))));
    }

    function test_ConfigFor_RevertWhen_UnsupportedChain() public {
        vm.expectRevert(abi.encodeWithSelector(DeployDemoPassThrough.UnsupportedChain.selector, 143));
        script.configFor(143);
        vm.expectRevert(abi.encodeWithSelector(DeployDemoPassThrough.UnsupportedChain.selector, 1));
        script.deployPlan(1);
    }
}
