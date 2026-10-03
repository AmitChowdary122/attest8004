// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {DemoAgentVault} from "../src/DemoAgentVault.sol";
import {Action} from "../src/ActionHash.sol";
import {AttestGateFixture} from "./helpers/AttestGateFixture.sol";
import {MockTarget} from "./mocks/MockTarget.sol";
import {ReentrantTarget} from "./mocks/ReentrantTarget.sol";

/// @notice DemoAgentVault-specific behaviour (SPEC §4.3): bound to one agent, holds native funds,
/// and makes the validated call. The gate checks themselves are in AttestGate.t.sol.
contract DemoAgentVaultTest is AttestGateFixture {
    function test_Constructor_StoresAgentId() public view {
        assertEq(vault.agentId(), agentId);
    }

    function test_Receive_AcceptsNativeFunds() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(vault).balance, VAULT_BALANCE + 1 ether);
    }

    /// Another agent's owner gets a fully valid verdict for an action of their own agent at this
    /// vault. It still can't move this agent's funds.
    function test_Execute_RevertWhen_ActionForOtherAgent() public {
        Action memory b = _action();
        b.agentId = attackerAgentId;
        _validate(vault, b, validatorA, 100);
        vm.expectRevert(abi.encodeWithSelector(DemoAgentVault.NotVaultAgent.selector, agentId, attackerAgentId));
        vault.execute(b);
    }

    function test_Execute_NativeTransferToEoa() public {
        address payee = makeAddr("payee");
        Action memory a = _action();
        a.target = payee;
        a.value = 0.5 ether;
        a.data = "";
        _validate(vault, a, validatorA, 100);

        bytes memory result = vault.execute(a);

        assertEq(result.length, 0);
        assertEq(payee.balance, 0.5 ether);
        assertEq(address(vault).balance, VAULT_BALANCE - 0.5 ether);
    }

    /// A failed call reverts the whole execute, consumption included, so the same validated action
    /// can be retried until its deadline.
    function test_Execute_RevertWhen_TargetReverts_IsRetryable() public {
        Action memory a = _action();
        _validate(vault, a, validatorA, 100);
        target.setFail(true);

        vm.expectRevert(
            abi.encodeWithSelector(
                DemoAgentVault.CallFailed.selector, abi.encodeWithSelector(MockTarget.TargetFailed.selector)
            )
        );
        vault.execute(a);
        assertFalse(vault.consumed(vault.actionHashOf(a)));

        target.setFail(false);
        vault.execute(a);
        assertTrue(vault.consumed(vault.actionHashOf(a)));
    }

    function test_Execute_RevertWhen_InsufficientBalance() public {
        Action memory a = _action();
        a.value = VAULT_BALANCE + 1;
        _validate(vault, a, validatorA, 100);
        vm.expectRevert(abi.encodeWithSelector(DemoAgentVault.CallFailed.selector, bytes("")));
        vault.execute(a);
    }

    /// The validated, deadline-bound action is the authorisation; who submits it doesn't matter.
    function test_Execute_AnyCallerCanSubmitValidatedAction() public {
        Action memory a = _action();
        _validate(vault, a, validatorA, 100);
        vm.prank(stranger);
        vault.execute(a);
        assertEq(target.lastCaller(), address(vault));
    }

    function test_Execute_ReentrancyBlocked() public {
        (ReentrantTarget reentrant, Action memory outer, Action memory inner) = _armReentrant();

        vault.execute(outer);

        assertTrue(reentrant.poked());
        assertFalse(reentrant.innerSucceeded());
        assertEq(
            reentrant.innerRevertData(),
            abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
        );
        assertFalse(vault.consumed(vault.actionHashOf(inner)));

        vault.execute(inner); // the second action was never spent
        assertTrue(vault.consumed(vault.actionHashOf(inner)));
    }

    function test_Execute_ConsumedBeforeExternalCall() public {
        (ReentrantTarget reentrant, Action memory outer,) = _armReentrant();
        vault.execute(outer);
        assertTrue(reentrant.sawConsumed());
    }

    /// `outer` calls ReentrantTarget.poke(), which watches outer's actionHash and tries to execute
    /// `inner` (1 ether to MockTarget) from inside the call. Both are validated.
    function _armReentrant() internal returns (ReentrantTarget reentrant, Action memory outer, Action memory inner) {
        reentrant = new ReentrantTarget();
        outer = _action();
        outer.target = address(reentrant);
        outer.value = 0;
        outer.data = abi.encodeCall(ReentrantTarget.poke, ());
        inner = _action();
        inner.salt = keccak256("inner");
        _validate(vault, outer, validatorA, 100);
        _validate(vault, inner, validatorA, 100);
        reentrant.arm(vault, vault.actionHashOf(outer), inner);
    }
}
