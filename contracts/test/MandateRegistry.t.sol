// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MandateRegistryHookHarness} from "./mocks/MandateRegistryHookHarness.sol";

/// @notice SPEC §4.2 (as built in P4): the agent owner sets and revokes a spending mandate — the
/// targets and selectors it covers, per-tx/per-day MON caps and an expiry. Every change goes
/// through `_authorize`, which here requires `msg.sender == identityRegistry.ownerOf(agentId)`; P6
/// replaces that body with a WebAuthn assertion, which is why `test_Hook_EveryChangeGoesThroughAuthorize`
/// pins the ordering against a hook that can be told to misbehave.
contract MandateRegistryTest is Test {
    MockIdentityRegistry internal identity;
    MandateRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal newOwner = makeAddr("newOwner");
    address internal stranger = makeAddr("stranger");

    uint256 internal agent1;

    event MandateSet(
        uint256 indexed agentId,
        bytes32 indexed mandateHash,
        address indexed owner,
        address[] allowedTargets,
        bytes4[] allowedSelectors,
        uint256 maxValuePerTx,
        uint256 maxValuePerDay,
        uint64 validUntil,
        uint64 setAtBlock
    );
    event MandateRevoked(uint256 indexed agentId, bytes32 indexed mandateHash, address indexed owner);

    function setUp() public {
        identity = new MockIdentityRegistry();
        registry = new MandateRegistry(address(identity));

        vm.prank(owner);
        agent1 = identity.register();
    }

    // ----------------------------------------------------------- helpers

    function _addresses(uint256 n) internal pure returns (address[] memory out) {
        out = new address[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = address(uint160(0x1000 + i));
        }
    }

    function _selectors(uint256 n) internal pure returns (bytes4[] memory out) {
        out = new bytes4[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = bytes4(uint32(0x1000 + i));
        }
    }

    function _validMandate() internal view returns (MandateRegistry.Mandate memory) {
        return MandateRegistry.Mandate({
            allowedTargets: _addresses(2),
            allowedSelectors: _selectors(2),
            maxValuePerTx: 1 ether,
            maxValuePerDay: 2 ether,
            validUntil: uint64(block.timestamp + 1 days)
        });
    }

    function _oneTargetMandate(address target, bytes4 selector, uint256 maxTx, uint256 maxDay, uint64 validUntil)
        internal
        pure
        returns (MandateRegistry.Mandate memory mandate)
    {
        address[] memory targets = new address[](1);
        targets[0] = target;
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = selector;
        mandate = MandateRegistry.Mandate({
            allowedTargets: targets,
            allowedSelectors: selectors,
            maxValuePerTx: maxTx,
            maxValuePerDay: maxDay,
            validUntil: validUntil
        });
    }

    // ----------------------------------------------------------- constructor

    function test_Constructor_RevertWhen_ZeroIdentityRegistry() public {
        vm.expectRevert(MandateRegistry.ZeroIdentityRegistry.selector);
        new MandateRegistry(address(0));
    }

    // ----------------------------------------------------------- setMandate

    function test_SetMandate_ByOwner_StoresAndEmits() public {
        MandateRegistry.Mandate memory mandate = _validMandate();
        bytes32 hash = registry.mandateHashOf(mandate);
        uint64 expectedBlock = uint64(block.number);

        vm.expectEmit(address(registry));
        emit MandateSet(
            agent1,
            hash,
            owner,
            mandate.allowedTargets,
            mandate.allowedSelectors,
            mandate.maxValuePerTx,
            mandate.maxValuePerDay,
            mandate.validUntil,
            expectedBlock
        );
        vm.prank(owner);
        registry.setMandate(agent1, mandate);

        (MandateRegistry.Mandate memory stored, bytes32 storedHash, address storedOwner, uint64 setAtBlock) =
            registry.getMandate(agent1);
        assertEq(storedHash, hash, "mandateHash");
        assertEq(storedOwner, owner, "owner");
        assertEq(setAtBlock, expectedBlock, "setAtBlock");
        assertEq(stored.allowedTargets.length, mandate.allowedTargets.length, "targets length");
        for (uint256 i; i < mandate.allowedTargets.length; ++i) {
            assertEq(stored.allowedTargets[i], mandate.allowedTargets[i], "target");
        }
        assertEq(stored.allowedSelectors.length, mandate.allowedSelectors.length, "selectors length");
        for (uint256 i; i < mandate.allowedSelectors.length; ++i) {
            assertEq(stored.allowedSelectors[i], mandate.allowedSelectors[i], "selector");
        }
        assertEq(stored.maxValuePerTx, mandate.maxValuePerTx, "maxValuePerTx");
        assertEq(stored.maxValuePerDay, mandate.maxValuePerDay, "maxValuePerDay");
        assertEq(stored.validUntil, mandate.validUntil, "validUntil");
    }

    function test_SetMandate_RevertWhen_NotOwner() public {
        MandateRegistry.Mandate memory mandate = _validMandate();

        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.NotAgentOwner.selector, agent1, stranger));
        vm.prank(stranger);
        registry.setMandate(agent1, mandate);

        address operator = makeAddr("operator");
        vm.prank(owner);
        identity.setApprovalForAll(operator, true);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.NotAgentOwner.selector, agent1, operator));
        vm.prank(operator);
        registry.setMandate(agent1, mandate);

        address approved = makeAddr("approved");
        vm.prank(owner);
        identity.approve(approved, agent1);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.NotAgentOwner.selector, agent1, approved));
        vm.prank(approved);
        registry.setMandate(agent1, mandate);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 999));
        vm.prank(owner);
        registry.setMandate(999, mandate);
    }

    function test_SetMandate_RevertWhen_Invalid() public {
        MandateRegistry.Mandate memory expired = _validMandate();
        expired.validUntil = uint64(block.timestamp);
        vm.expectRevert(
            abi.encodeWithSelector(MandateRegistry.MandateAlreadyExpired.selector, expired.validUntil, block.timestamp)
        );
        vm.prank(owner);
        registry.setMandate(agent1, expired);

        MandateRegistry.Mandate memory manyTargets = _validMandate();
        manyTargets.allowedTargets = _addresses(17);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.TooManyTargets.selector, 17));
        vm.prank(owner);
        registry.setMandate(agent1, manyTargets);

        MandateRegistry.Mandate memory manySelectors = _validMandate();
        manySelectors.allowedSelectors = _selectors(17);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.TooManySelectors.selector, 17));
        vm.prank(owner);
        registry.setMandate(agent1, manySelectors);

        MandateRegistry.Mandate memory zeroTarget = _validMandate();
        zeroTarget.allowedTargets[0] = address(0);
        vm.expectRevert(MandateRegistry.ZeroTarget.selector);
        vm.prank(owner);
        registry.setMandate(agent1, zeroTarget);

        MandateRegistry.Mandate memory capInverted = _validMandate();
        capInverted.maxValuePerTx = 3 ether;
        capInverted.maxValuePerDay = 2 ether;
        vm.expectRevert(
            abi.encodeWithSelector(
                MandateRegistry.TxCapAboveDailyCap.selector, capInverted.maxValuePerTx, capInverted.maxValuePerDay
            )
        );
        vm.prank(owner);
        registry.setMandate(agent1, capInverted);

        // Boundary values that must pass.
        MandateRegistry.Mandate memory justValid = _validMandate();
        justValid.validUntil = uint64(block.timestamp + 1);
        vm.prank(owner);
        registry.setMandate(agent1, justValid);

        MandateRegistry.Mandate memory equalCaps = _validMandate();
        equalCaps.maxValuePerTx = 1 ether;
        equalCaps.maxValuePerDay = 1 ether;
        vm.prank(owner);
        registry.setMandate(agent1, equalCaps);
    }

    /// The passing side of the 16-entry caps: exactly MAX_TARGETS targets and MAX_SELECTORS selectors
    /// are accepted, and stored in full.
    function test_SetMandate_ExactlyMaxTargetsAndSelectors_Passes() public {
        assertEq(registry.MAX_TARGETS(), 16, "MAX_TARGETS");
        assertEq(registry.MAX_SELECTORS(), 16, "MAX_SELECTORS");
        MandateRegistry.Mandate memory full = _validMandate();
        full.allowedTargets = _addresses(16);
        full.allowedSelectors = _selectors(16);

        vm.prank(owner);
        registry.setMandate(agent1, full);

        (MandateRegistry.Mandate memory stored, bytes32 storedHash,,) = registry.getMandate(agent1);
        assertEq(storedHash, registry.mandateHashOf(full), "mandateHash");
        assertEq(stored.allowedTargets.length, 16, "targets length");
        assertEq(stored.allowedSelectors.length, 16, "selectors length");
        for (uint256 i; i < 16; ++i) {
            assertEq(stored.allowedTargets[i], full.allowedTargets[i], "target");
            assertEq(stored.allowedSelectors[i], full.allowedSelectors[i], "selector");
        }
    }

    function test_SetMandate_Overwrite_ReplacesArraysCompletely() public {
        MandateRegistry.Mandate memory first = _validMandate();
        first.allowedTargets = _addresses(3);
        first.allowedSelectors = _selectors(3);
        vm.prank(owner);
        registry.setMandate(agent1, first);

        MandateRegistry.Mandate memory second = _validMandate();
        second.allowedTargets = _addresses(1);
        second.allowedSelectors = _selectors(1);
        vm.prank(owner);
        registry.setMandate(agent1, second);

        (MandateRegistry.Mandate memory stored,,,) = registry.getMandate(agent1);
        assertEq(stored.allowedTargets.length, 1, "targets replaced, not appended");
        assertEq(stored.allowedTargets[0], second.allowedTargets[0]);
        assertEq(stored.allowedSelectors.length, 1, "selectors replaced, not appended");
        assertEq(stored.allowedSelectors[0], second.allowedSelectors[0]);
    }

    function test_SetMandate_AfterTransfer() public {
        MandateRegistry.Mandate memory mandate = _validMandate();
        vm.prank(owner);
        registry.setMandate(agent1, mandate);
        (, bytes32 oldHash, address oldRecordOwner, uint64 oldSetAtBlock) = registry.getMandate(agent1);
        assertEq(oldRecordOwner, owner);

        vm.prank(owner);
        identity.transferFrom(owner, newOwner, agent1);

        // The old record still names the old owner; a transfer alone never rewrites it.
        (, bytes32 hashAfterTransfer, address ownerAfterTransfer, uint64 setAtBlockAfterTransfer) =
            registry.getMandate(agent1);
        assertEq(hashAfterTransfer, oldHash, "record untouched by transfer");
        assertEq(ownerAfterTransfer, owner, "still names the old owner");
        assertEq(setAtBlockAfterTransfer, oldSetAtBlock);

        // The old owner can no longer change it.
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.NotAgentOwner.selector, agent1, owner));
        vm.prank(owner);
        registry.setMandate(agent1, mandate);

        // The new owner can set a fresh mandate.
        MandateRegistry.Mandate memory second = _validMandate();
        second.allowedTargets = _addresses(1);
        vm.prank(newOwner);
        registry.setMandate(agent1, second);

        (,, address ownerNow,) = registry.getMandate(agent1);
        assertEq(ownerNow, newOwner);
    }

    // ----------------------------------------------------------- revokeMandate

    function test_RevokeMandate_ByOwner_ClearsAndEmits() public {
        MandateRegistry.Mandate memory mandate = _validMandate();
        vm.prank(owner);
        registry.setMandate(agent1, mandate);
        bytes32 hash = registry.mandateHashOf(mandate);

        vm.expectEmit(address(registry));
        emit MandateRevoked(agent1, hash, owner);
        vm.prank(owner);
        registry.revokeMandate(agent1);

        (MandateRegistry.Mandate memory stored, bytes32 storedHash, address storedOwner, uint64 setAtBlock) =
            registry.getMandate(agent1);
        assertEq(stored.allowedTargets.length, 0, "targets cleared");
        assertEq(stored.allowedSelectors.length, 0, "selectors cleared");
        assertEq(stored.maxValuePerTx, 0);
        assertEq(stored.maxValuePerDay, 0);
        assertEq(stored.validUntil, 0);
        assertEq(storedHash, bytes32(0));
        assertEq(storedOwner, address(0));
        assertEq(setAtBlock, 0);

        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.NoMandate.selector, agent1));
        vm.prank(owner);
        registry.revokeMandate(agent1);

        // A stranger may never revoke, even when a mandate exists.
        vm.prank(owner);
        registry.setMandate(agent1, mandate);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.NotAgentOwner.selector, agent1, stranger));
        vm.prank(stranger);
        registry.revokeMandate(agent1);
    }

    // ----------------------------------------------------------- the _authorize hook

    /// P6 will replace `_authorize`'s body with WebAuthn verification, so every change must already
    /// go through it, before any write, regardless of what the hook does.
    function test_Hook_EveryChangeGoesThroughAuthorize() public {
        MandateRegistryHookHarness harness = new MandateRegistryHookHarness(address(identity));

        MandateRegistry.Mandate memory first = _validMandate();
        bytes32 firstHash = harness.mandateHashOf(first);

        vm.prank(owner);
        harness.setMandate(agent1, first);
        assertEq(harness.authorizeCalls(), 1);
        assertEq(harness.lastAgentId(), agent1);
        assertEq(harness.lastChangeHash(), firstHash, "setMandate authorizes with the mandateHash");
        assertEq(harness.mandateHashBeforeWrite(), bytes32(0), "authorize saw the pre-write (empty) state");
        (, bytes32 storedHash,,) = harness.getMandate(agent1);
        assertEq(storedHash, firstHash);

        vm.prank(owner);
        harness.revokeMandate(agent1);
        assertEq(harness.authorizeCalls(), 2);
        assertEq(harness.lastChangeHash(), harness.REVOKE(), "revokeMandate authorizes with REVOKE");
        assertEq(harness.mandateHashBeforeWrite(), firstHash, "authorize saw the pre-write (still set) state");
        (, bytes32 hashAfterRevoke,,) = harness.getMandate(agent1);
        assertEq(hashAfterRevoke, bytes32(0));

        // Re-set it, so there is live state for a reverting hook to (fail to) touch.
        vm.prank(owner);
        harness.setMandate(agent1, first);
        assertEq(harness.authorizeCalls(), 3);

        harness.setShouldRevert(true);

        // A reverted call rolls back every state change it made, including the harness's own
        // counters (EVM semantics) — so the observable proof here is that the registry's own
        // state survives untouched, not that authorizeCalls kept counting.
        MandateRegistry.Mandate memory second = _validMandate();
        second.allowedTargets = _addresses(5);
        vm.expectRevert(bytes("MandateRegistryHookHarness: reverted"));
        vm.prank(owner);
        harness.setMandate(agent1, second);
        assertEq(harness.authorizeCalls(), 3, "the reverted call's own counter increment is rolled back too");
        (, bytes32 hashUnchangedAfterSet,,) = harness.getMandate(agent1);
        assertEq(hashUnchangedAfterSet, firstHash, "setMandate must not write when the hook reverts");

        vm.expectRevert(bytes("MandateRegistryHookHarness: reverted"));
        vm.prank(owner);
        harness.revokeMandate(agent1);
        assertEq(harness.authorizeCalls(), 3, "the reverted call's own counter increment is rolled back too");
        (, bytes32 hashUnchangedAfterRevoke,,) = harness.getMandate(agent1);
        assertEq(hashUnchangedAfterRevoke, firstHash, "revokeMandate must not clear when the hook reverts");
    }

    // ----------------------------------------------------------- mandateHashOf

    function testFuzz_MandateHash_BindsEveryField(
        address target,
        bytes4 selector,
        uint128 maxTx,
        uint128 maxDayExtra,
        uint64 validUntil
    ) public view {
        vm.assume(target != address(0));
        uint256 maxDay = uint256(maxTx) + maxDayExtra;

        MandateRegistry.Mandate memory base = _oneTargetMandate(target, selector, maxTx, maxDay, validUntil);
        bytes32 baseHash = registry.mandateHashOf(base);

        address otherTarget = target == address(0x1) ? address(0x2) : address(0x1);
        assertTrue(
            registry.mandateHashOf(_oneTargetMandate(otherTarget, selector, maxTx, maxDay, validUntil)) != baseHash,
            "allowedTargets"
        );

        bytes4 otherSelector = selector == bytes4(0x11111111) ? bytes4(0x22222222) : bytes4(0x11111111);
        assertTrue(
            registry.mandateHashOf(_oneTargetMandate(target, otherSelector, maxTx, maxDay, validUntil)) != baseHash,
            "allowedSelectors"
        );

        assertTrue(
            registry.mandateHashOf(_oneTargetMandate(target, selector, uint256(maxTx) + 1, maxDay, validUntil))
                != baseHash,
            "maxValuePerTx"
        );

        assertTrue(
            registry.mandateHashOf(_oneTargetMandate(target, selector, maxTx, maxDay + 1, validUntil)) != baseHash,
            "maxValuePerDay"
        );

        uint64 otherValidUntil = validUntil == type(uint64).max ? validUntil - 1 : validUntil + 1;
        assertTrue(
            registry.mandateHashOf(_oneTargetMandate(target, selector, maxTx, maxDay, otherValidUntil)) != baseHash,
            "validUntil"
        );
    }

    // ----------------------------------------------------------- no ether

    function test_NoEther() public {
        vm.deal(stranger, 1 ether);
        vm.startPrank(stranger);
        (bool sent,) = address(registry).call{value: 1}("");
        assertFalse(sent, "plain transfer");
        (bool calledWithValue,) = address(registry).call{value: 1}(hex"12345678");
        assertFalse(calledWithValue, "unknown calldata with value");
        (bool calledWithoutValue,) = address(registry).call(hex"12345678");
        assertFalse(calledWithoutValue, "unknown calldata without value");
        vm.stopPrank();
        assertEq(address(registry).balance, 0);
    }
}
