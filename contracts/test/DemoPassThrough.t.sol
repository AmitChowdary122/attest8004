// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Action} from "../src/ActionHash.sol";
import {DemoPassThrough} from "../src/DemoPassThrough.sol";
import {ReentrantTarget} from "./mocks/ReentrantTarget.sol";
import {AttestGateFixture} from "./helpers/AttestGateFixture.sol";

/// @notice DemoPassThrough (SPEC §4.6, the risky-but-mandated demo scenario): a fresh "payment
/// router" that forwards every payment straight to its immutable `sink`, an address nobody
/// controls. The gate/vault test shows mandate-v1 would allow a plain transfer to it like any
/// other allowlisted target; seeing the value keep moving on to `sink` is risk-v1's job, not
/// tested here.
contract DemoPassThroughTest is AttestGateFixture {
    address payable internal sink = payable(makeAddr("sink"));
    DemoPassThrough internal passThrough;

    function setUp() public override {
        super.setUp();
        passThrough = new DemoPassThrough(sink);
    }

    function test_Constructor_RevertWhen_ZeroSink() public {
        vm.expectRevert(DemoPassThrough.ZeroSink.selector);
        new DemoPassThrough(payable(address(0)));
    }

    function test_Receive_ForwardsAllValueToSink() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(passThrough).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(sink.balance, 1 ether);
        assertEq(address(passThrough).balance, 0);
    }

    function testFuzz_Receive_Forwards(uint96 v) public {
        vm.deal(stranger, v);
        vm.prank(stranger);
        (bool ok,) = address(passThrough).call{value: v}("");
        assertTrue(ok);
        assertEq(sink.balance, v);
        assertEq(address(passThrough).balance, 0);
    }

    /// `ReentrantTarget` has neither `receive` nor `fallback`, so forwarding to it as the sink
    /// fails outright (no function to dispatch to), with no return data.
    function test_Receive_RevertWhen_SinkReverts() public {
        ReentrantTarget revertingSink = new ReentrantTarget();
        DemoPassThrough target = new DemoPassThrough(payable(address(revertingSink)));
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DemoPassThrough.ForwardFailed.selector, bytes("")));
        (bool ok,) = address(target).call{value: 1 ether}("");
        assertFalse(ok);
    }

    /// There is no `fallback`: a call that carries data has no matching function, so the EVM's
    /// own dispatch failure reverts before `receive` ever runs.
    function test_Call_WithData_Reverts() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(passThrough).call{value: 1 ether}(hex"1234");
        assertFalse(ok);
        assertEq(sink.balance, 0);
        assertEq(address(passThrough).balance, 0);
    }

    /// A vault action targeting the pass-through with empty data. The gate now requires each
    /// verdict's tag; `_validate` (AttestGateFixture) defaults validatorA's to `TAG_A`, the
    /// vault's own requirement.
    function test_ViaVault_ExecutesValidatedTransfer() public {
        Action memory a = _action();
        a.target = address(passThrough);
        a.value = 0.5 ether;
        a.data = "";
        _validate(vault, a, validatorA, 100);

        vault.execute(a);

        assertEq(sink.balance, 0.5 ether);
        assertEq(address(passThrough).balance, 0);
        assertEq(address(vault).balance, VAULT_BALANCE - 0.5 ether);
    }
}
