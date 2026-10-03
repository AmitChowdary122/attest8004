// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Action, ActionHash} from "../../src/ActionHash.sol";

/// @notice Exposes the internal ActionHash library with explicit chainId and gate, so tests can
/// check it against the shared vectors (packages/sdk/test/vectors.json).
contract ActionHashHarness {
    function actionHash(Action calldata action, uint256 chainId, address gate) external pure returns (bytes32) {
        return ActionHash.actionHash(action, chainId, gate);
    }

    function requestHash(Action calldata action, uint256 chainId, address gate, address validator)
        external
        pure
        returns (bytes32)
    {
        return ActionHash.requestHash(action, chainId, gate, validator);
    }
}
