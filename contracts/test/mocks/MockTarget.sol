// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

/// @notice A call target for gate tests: records what the vault sent, and can be told to revert.
contract MockTarget {
    error TargetFailed();

    address public lastCaller;
    uint256 public lastValue;
    uint256 public lastArg;
    bool public fail;

    function setFail(bool fail_) external {
        fail = fail_;
    }

    function ping(uint256 arg) external payable returns (uint256) {
        if (fail) revert TargetFailed();
        lastCaller = msg.sender;
        lastValue = msg.value;
        lastArg = arg;
        return arg * 2;
    }
}
