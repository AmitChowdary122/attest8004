// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {AttestGate} from "../src/AttestGate.sol";
import {DemoAgentVault} from "../src/DemoAgentVault.sol";
import {Action} from "../src/ActionHash.sol";
import {AttestGateFixture} from "./helpers/AttestGateFixture.sol";

/// @notice SPEC §4.3: the gate executes an action only if every required validator's verdict for
/// exactly that action (this chain, this gate, this agent) meets its minimum score, once.
/// DemoAgentVault is the concrete gate under test.
contract AttestGateTest is AttestGateFixture {
    // ----------------------------------------------------------- constructor

    function test_Constructor_StoresRegistry() public view {
        assertEq(address(vault.validationRegistry()), address(registry));
    }

    function test_Constructor_RevertWhen_ZeroRegistry() public {
        vm.expectRevert(AttestGate.ZeroValidationRegistry.selector);
        new DemoAgentVault(address(0), agentId, _reqs(validatorA, 100));
    }

    function test_Constructor_RevertWhen_NoRequirements() public {
        vm.expectRevert(AttestGate.NoRequirements.selector);
        new DemoAgentVault(address(registry), agentId, new AttestGate.Requirement[](0));
    }

    function test_Constructor_RevertWhen_TooManyRequirements() public {
        AttestGate.Requirement[] memory r = new AttestGate.Requirement[](5);
        for (uint256 i; i < 5; ++i) {
            r[i] = AttestGate.Requirement(address(uint160(0x1000 + i)), 50, keccak256(bytes(TAG_A)));
        }
        vm.expectRevert(abi.encodeWithSelector(AttestGate.TooManyRequirements.selector, 5, 4));
        new DemoAgentVault(address(registry), agentId, r);
    }

    function test_Constructor_RevertWhen_ZeroValidator() public {
        vm.expectRevert(AttestGate.ZeroValidator.selector);
        new DemoAgentVault(address(registry), agentId, _reqs(validatorA, 100, address(0), 50));
    }

    /// A pending request reads as response 0, so a minimum of 0 would pass unvalidated actions.
    function test_Constructor_RevertWhen_MinScoreZero() public {
        vm.expectRevert(abi.encodeWithSelector(AttestGate.InvalidMinScore.selector, validatorA, 0));
        new DemoAgentVault(address(registry), agentId, _reqs(validatorA, 0));
    }

    function test_Constructor_RevertWhen_MinScoreAbove100() public {
        vm.expectRevert(abi.encodeWithSelector(AttestGate.InvalidMinScore.selector, validatorB, 101));
        new DemoAgentVault(address(registry), agentId, _reqs(validatorA, 100, validatorB, 101));
    }

    function test_Constructor_RevertWhen_DuplicateValidator() public {
        vm.expectRevert(abi.encodeWithSelector(AttestGate.DuplicateValidator.selector, validatorA));
        new DemoAgentVault(address(registry), agentId, _reqs(validatorA, 100, validatorA, 50));
    }

    /// No real tag hashes to the zero value, so a zero tagHash would be a requirement nothing
    /// could ever satisfy, locking the gate shut; the constructor rejects it up front.
    function test_Constructor_RevertWhen_ZeroTagHash() public {
        AttestGate.Requirement[] memory r = new AttestGate.Requirement[](1);
        r[0] = AttestGate.Requirement(validatorA, 100, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(AttestGate.ZeroTagHash.selector, validatorA));
        new DemoAgentVault(address(registry), agentId, r);
    }

    function test_Requirements_ReturnsTagHashes() public {
        string[4] memory tags = ["mandate-v1", "risk-v1", "tag-c", "tag-d"];
        AttestGate.Requirement[] memory r = new AttestGate.Requirement[](4);
        r[0] = AttestGate.Requirement(validatorA, 100, keccak256(bytes(tags[0])));
        r[1] = AttestGate.Requirement(validatorB, 1, keccak256(bytes(tags[1])));
        r[2] = AttestGate.Requirement(validatorC, 99, keccak256(bytes(tags[2])));
        r[3] = AttestGate.Requirement(address(type(uint160).max), 50, keccak256(bytes(tags[3])));
        DemoAgentVault v = new DemoAgentVault(address(registry), agentId, r);

        AttestGate.Requirement[] memory got = v.requirements();
        assertEq(got.length, 4);
        for (uint256 i; i < 4; ++i) {
            assertEq(got[i].validator, r[i].validator);
            assertEq(got[i].minScore, r[i].minScore);
            assertEq(got[i].tagHash, keccak256(bytes(tags[i])));
        }
        assertEq(v.MAX_REQUIREMENTS(), 4);
    }

    // ------------------------------------------------------------ happy path

    function test_Execute_ValidatedAction_CallsTargetAndConsumes() public {
        Action memory a = _action();
        _validate(vault, a, validatorA, 100);
        bytes32 actionHash = vault.actionHashOf(a);

        vm.expectEmit(true, true, false, true, address(vault));
        emit AttestGate.ActionConsumed(actionHash, agentId);
        bytes memory result = vault.execute(a);

        assertEq(abi.decode(result, (uint256)), 14);
        assertEq(target.lastCaller(), address(vault));
        assertEq(target.lastValue(), 1 ether);
        assertEq(target.lastArg(), 7);
        assertEq(address(target).balance, 1 ether);
        assertEq(address(vault).balance, VAULT_BALANCE - 1 ether);
        assertTrue(vault.consumed(actionHash));
    }

    function test_Execute_AtDeadline_Succeeds() public {
        Action memory a = _action();
        _validate(vault, a, validatorA, 100);
        vm.warp(a.deadline);
        vault.execute(a);
        assertTrue(vault.consumed(vault.actionHashOf(a)));
    }

    // --------------------------------------------------------------- reverts

    function test_Execute_RevertWhen_Unvalidated() public {
        Action memory a = _action();
        vm.expectRevert(_err(AttestGate.ValidationNotFound.selector, validatorA, vault.requestHashOf(a, validatorA)));
        vault.execute(a);
    }

    /// A request with no response yet reads as response 0 in the registry.
    function test_Execute_RevertWhen_Pending() public {
        Action memory a = _action();
        bytes32 rh = _requestOnly(vault, a, validatorA);
        vm.expectRevert(abi.encodeWithSelector(AttestGate.ScoreTooLow.selector, validatorA, rh, 0, 100));
        vault.execute(a);
    }

    /// Validator A names the right validator and a sufficient score, but a tag that isn't the
    /// requirement's: the gate must still refuse the action.
    function test_Execute_RevertWhen_WrongTag() public {
        Action memory a = _action();
        bytes32 rh = _requestOnly(vault, a, validatorA);
        _respond(validatorA, rh, 100, "other");
        vm.expectRevert(
            abi.encodeWithSelector(
                AttestGate.TagMismatch.selector, validatorA, rh, keccak256(bytes(TAG_A)), keccak256(bytes("other"))
            )
        );
        vault.execute(a);
    }

    /// The score is checked before the tag, so an insufficient score reverts ScoreTooLow even when
    /// the tag is also wrong.
    function test_Execute_ScoreCheckedBeforeTag() public {
        Action memory a = _action();
        bytes32 rh = _requestOnly(vault, a, validatorA);
        _respond(validatorA, rh, 99, "other");
        vm.expectRevert(abi.encodeWithSelector(AttestGate.ScoreTooLow.selector, validatorA, rh, 99, 100));
        vault.execute(a);
    }

    function test_Execute_RevertWhen_LowScore() public {
        Action memory a = _action();
        bytes32 rh = _validate(vault, a, validatorA, 99);
        vm.expectRevert(abi.encodeWithSelector(AttestGate.ScoreTooLow.selector, validatorA, rh, 99, 100));
        vault.execute(a);
    }

    /// EIP-8004 allows progressive responses; the gate must use the latest one.
    function test_Execute_RevertWhen_ScoreLoweredAfterPass() public {
        Action memory a = _action();
        bytes32 rh = _validate(vault, a, validatorA, 100);
        _respond(validatorA, rh, 0);
        vm.expectRevert(abi.encodeWithSelector(AttestGate.ScoreTooLow.selector, validatorA, rh, 0, 100));
        vault.execute(a);
    }

    function test_Execute_RevertWhen_OnlyUntrustedValidatorResponded() public {
        Action memory a = _action();
        _validate(vault, a, validatorC, 100);
        vm.expectRevert(_err(AttestGate.ValidationNotFound.selector, validatorA, vault.requestHashOf(a, validatorA)));
        vault.execute(a);
    }

    /// Validator A's requestHash, but the request names validator C, who answers 100.
    function test_Execute_RevertWhen_HashRequestedFromUntrustedValidator() public {
        Action memory a = _action();
        bytes32 rhA = vault.requestHashOf(a, validatorA);
        _request(owner, agentId, validatorC, rhA);
        _respond(validatorC, rhA, 100);
        vm.expectRevert(abi.encodeWithSelector(AttestGate.ValidatorMismatch.selector, rhA, validatorA, validatorC));
        vault.execute(a);
    }

    /// The owner of another agent claims our requestHash first (spec-notes, row 12), naming the
    /// trusted validator, who answers 100. The stored agentId is the squatter's.
    function test_Execute_RevertWhen_SquattedHashFromOtherAgent() public {
        Action memory a = _action();
        bytes32 rhA = vault.requestHashOf(a, validatorA);
        _request(attacker, attackerAgentId, validatorA, rhA);
        _respond(validatorA, rhA, 100);
        vm.expectRevert(abi.encodeWithSelector(AttestGate.AgentMismatch.selector, rhA, agentId, attackerAgentId));
        vault.execute(a);
    }

    function test_Execute_RevertWhen_Expired() public {
        Action memory a = _action();
        _validate(vault, a, validatorA, 100);
        vm.warp(uint256(a.deadline) + 1);
        vm.expectRevert(abi.encodeWithSelector(AttestGate.ActionExpired.selector, a.deadline, uint256(a.deadline) + 1));
        vault.execute(a);
    }

    function test_Execute_RevertWhen_Replayed() public {
        Action memory a = _action();
        _validate(vault, a, validatorA, 100);
        vault.execute(a);
        vm.expectRevert(abi.encodeWithSelector(AttestGate.ActionAlreadyConsumed.selector, vault.actionHashOf(a)));
        vault.execute(a);
    }

    function test_Execute_RevertWhen_DifferentAction() public {
        Action memory a = _action();
        _validate(vault, a, validatorA, 100);
        for (uint256 field; field < 5; ++field) {
            Action memory b = _mutate(a, field, bytes32(uint256(1)));
            vm.expectRevert(
                _err(AttestGate.ValidationNotFound.selector, validatorA, vault.requestHashOf(b, validatorA))
            );
            vault.execute(b);
        }
    }

    function test_Execute_RevertWhen_VerdictForAnotherGate() public {
        DemoAgentVault other = _vault(_reqs(validatorA, 100));
        Action memory a = _action();
        _validate(other, a, validatorA, 100);

        vm.expectRevert(_err(AttestGate.ValidationNotFound.selector, validatorA, vault.requestHashOf(a, validatorA)));
        vault.execute(a);

        other.execute(a); // the verdict is good where it was given
    }

    function test_Execute_RevertWhen_OtherChainId() public {
        Action memory a = _action();
        _validate(vault, a, validatorA, 100);
        vm.chainId(143);
        vm.expectRevert(_err(AttestGate.ValidationNotFound.selector, validatorA, vault.requestHashOf(a, validatorA)));
        vault.execute(a);
    }

    // -------------------------------------------------------- two validators

    function test_TwoValidators_BothPass_ExecutesOnce() public {
        DemoAgentVault v = _vault(_reqs(validatorA, 100, validatorB, 70));
        Action memory a = _action();
        _validate(v, a, validatorA, 100);
        _validate(v, a, validatorB, 70);

        v.execute(a);
        assertTrue(v.consumed(v.actionHashOf(a)));

        vm.expectRevert(abi.encodeWithSelector(AttestGate.ActionAlreadyConsumed.selector, v.actionHashOf(a)));
        v.execute(a);
    }

    function test_TwoValidators_RevertWhen_SecondNotRequested() public {
        DemoAgentVault v = _vault(_reqs(validatorA, 100, validatorB, 70));
        Action memory a = _action();
        _validate(v, a, validatorA, 100);
        vm.expectRevert(_err(AttestGate.ValidationNotFound.selector, validatorB, v.requestHashOf(a, validatorB)));
        v.execute(a);
    }

    function test_TwoValidators_RevertWhen_SecondPending() public {
        DemoAgentVault v = _vault(_reqs(validatorA, 100, validatorB, 70));
        Action memory a = _action();
        _validate(v, a, validatorA, 100);
        bytes32 rhB = _requestOnly(v, a, validatorB);
        vm.expectRevert(abi.encodeWithSelector(AttestGate.ScoreTooLow.selector, validatorB, rhB, 0, 70));
        v.execute(a);
    }

    function test_TwoValidators_RevertWhen_SecondBelowMin() public {
        DemoAgentVault v = _vault(_reqs(validatorA, 100, validatorB, 70));
        Action memory a = _action();
        _validate(v, a, validatorA, 100);
        bytes32 rhB = _validate(v, a, validatorB, 69);
        vm.expectRevert(abi.encodeWithSelector(AttestGate.ScoreTooLow.selector, validatorB, rhB, 69, 70));
        v.execute(a);
    }

    /// B's requirement is tagged TAG_B ("risk-v1"); B answers with TAG_A's string ("mandate-v1")
    /// instead, as if it had posted mandate-v1's verdict under its own key.
    function test_TwoValidators_RevertWhen_SecondWrongTag() public {
        DemoAgentVault v = _vault(_reqs(validatorA, 100, validatorB, 70));
        Action memory a = _action();
        _validate(v, a, validatorA, 100);
        bytes32 rhB = _requestOnly(v, a, validatorB);
        _respond(validatorB, rhB, 100, TAG_A);
        vm.expectRevert(
            abi.encodeWithSelector(
                AttestGate.TagMismatch.selector, validatorB, rhB, keccak256(bytes(TAG_B)), keccak256(bytes(TAG_A))
            )
        );
        v.execute(a);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_Execute_OnlyIfScoreAtLeastMin(uint8 score) public {
        score = uint8(bound(score, 0, 100));
        DemoAgentVault v = _vault(_reqs(validatorA, 70));
        Action memory a = _action();
        bytes32 rh = _validate(v, a, validatorA, score);

        if (score < 70) {
            vm.expectRevert(abi.encodeWithSelector(AttestGate.ScoreTooLow.selector, validatorA, rh, score, 70));
        }
        v.execute(a);
        assertEq(v.consumed(v.actionHashOf(a)), score >= 70);
    }

    /// The gate accepts an action's tag iff it hashes to the requirement's tagHash, whatever the
    /// string (including one that happens to collide only by being identical).
    function testFuzz_Execute_TagMustMatch(string memory tag) public {
        Action memory a = _action();
        bytes32 rh = _requestOnly(vault, a, validatorA);
        _respond(validatorA, rh, 100, tag);

        bool matches = keccak256(bytes(tag)) == keccak256(bytes(TAG_A));
        if (!matches) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    AttestGate.TagMismatch.selector, validatorA, rh, keccak256(bytes(TAG_A)), keccak256(bytes(tag))
                )
            );
        }
        vault.execute(a);
        assertEq(vault.consumed(vault.actionHashOf(a)), matches);
    }

    function testFuzz_Execute_RevertWhen_AnyFieldChanged(uint8 field, bytes32 noise) public {
        field = uint8(bound(field, 0, 4));
        vm.assume(noise != bytes32(0));
        Action memory a = _action();
        _validate(vault, a, validatorA, 100);

        Action memory b = _mutate(a, field, noise);
        vm.assume(vault.actionHashOf(b) != vault.actionHashOf(a));
        vm.expectRevert(_err(AttestGate.ValidationNotFound.selector, validatorA, vault.requestHashOf(b, validatorA)));
        vault.execute(b);
    }

    function testFuzz_Deadline(uint64 deadline, uint64 nowTs) public {
        Action memory a = _action();
        a.deadline = deadline;
        _validate(vault, a, validatorA, 100);
        vm.warp(nowTs);

        if (nowTs > deadline) {
            vm.expectRevert(abi.encodeWithSelector(AttestGate.ActionExpired.selector, deadline, uint256(nowTs)));
        }
        vault.execute(a);
    }

    // ----------------------------------------------------------------- views

    function test_RequestHashOf_MatchesManualEncoding() public view {
        Action memory a = _action();
        assertEq(
            vault.requestHashOf(a, validatorA),
            keccak256(
                abi.encode(
                    block.chainid,
                    address(vault),
                    validatorA,
                    a.agentId,
                    a.target,
                    a.value,
                    keccak256(a.data),
                    a.deadline,
                    a.salt
                )
            )
        );
        assertEq(
            vault.actionHashOf(a),
            keccak256(
                abi.encode(
                    block.chainid, address(vault), a.agentId, a.target, a.value, keccak256(a.data), a.deadline, a.salt
                )
            )
        );
    }

    // --------------------------------------------------------------- helpers

    /// Changes one field other than agentId (a different agentId fails the vault's own check
    /// first). The deadline only moves later, so the action stays unexpired.
    function _mutate(Action memory a, uint256 field, bytes32 noise) internal pure returns (Action memory b) {
        b = Action(a.agentId, a.target, a.value, a.data, a.deadline, a.salt);
        if (field == 0) b.target = address(uint160(a.target) ^ uint160(uint256(noise)));
        else if (field == 1) b.value = a.value ^ uint256(noise);
        else if (field == 2) b.data = abi.encodePacked(a.data, noise);
        else if (field == 3) b.deadline = a.deadline + 1 + uint64(uint256(noise) % 1_000_000);
        else b.salt = a.salt ^ noise;
    }
}
