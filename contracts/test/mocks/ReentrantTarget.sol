// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Action} from "../../src/ActionHash.sol";
import {DemoAgentVault} from "../../src/DemoAgentVault.sol";

/// @notice A call target that, while the vault is calling it, records whether the vault already
/// marked `watchHash` consumed, then tries to re-enter `execute` with a second action. It records
/// the outcome and never reverts itself, so the outer execute completes.
contract ReentrantTarget {
    DemoAgentVault public vault;
    bytes32 public watchHash;
    Action internal _inner;

    bool public poked;
    bool public sawConsumed;
    bool public innerSucceeded;
    bytes public innerRevertData;

    function arm(DemoAgentVault vault_, bytes32 watchHash_, Action calldata inner) external {
        vault = vault_;
        watchHash = watchHash_;
        _inner = inner;
    }

    function poke() external {
        poked = true;
        sawConsumed = vault.consumed(watchHash);
        try vault.execute(_inner) {
            innerSucceeded = true;
        } catch (bytes memory reason) {
            innerRevertData = reason;
        }
    }
}
