// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {FindingsBoard} from "../src/FindingsBoard.sol";
import {DeployFindingsBoard} from "../script/DeployFindingsBoard.s.sol";

contract DeployFindingsBoardTest is Test {
    address internal constant FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    DeployFindingsBoard internal script;

    function setUp() public {
        script = new DeployFindingsBoard();
    }

    function test_Deploy_AtPredictedCreate2Address() public {
        address predicted = script.predictedAddress();
        assertEq(
            predicted, vm.computeCreate2Address(script.SALT(), keccak256(type(FindingsBoard).creationCode), FACTORY)
        );
        assertEq(predicted.code.length, 0);

        FindingsBoard deployed = script.deploy();

        assertEq(address(deployed), predicted);
        assertGt(predicted.code.length, 0);
        assertEq(deployed.MAX_ENVELOPE_BYTES(), 8192);
    }

    function test_Deploy_IsIdempotent() public {
        FindingsBoard first = script.deploy();

        vm.expectCall(FACTORY, bytes(""), 0);
        FindingsBoard second = script.deploy();

        assertEq(address(second), address(first));
    }

    /// deploy-testnet.sh compares Monad's eth_estimateGas for exactly this call with the limit
    /// before it broadcasts, so the plan must describe the transaction deploy() sends.
    function test_DeployPlan_MatchesTheDeployTransaction() public view {
        (address to, bytes memory data, uint256 gasLimit, address predicted) = script.deployPlan(10143);
        assertEq(to, FACTORY);
        assertEq(data, abi.encodePacked(script.SALT(), type(FindingsBoard).creationCode));
        assertEq(gasLimit, script.DEPLOY_GAS());
        assertEq(predicted, script.predictedAddress());
    }

    function test_DeployPlan_RevertWhen_UnsupportedChain() public {
        vm.expectRevert(abi.encodeWithSelector(DeployFindingsBoard.UnsupportedChain.selector, 143));
        script.deployPlan(143);
    }
}
