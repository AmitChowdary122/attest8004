// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice An agent action that a gate executes only with validators' verdicts (SPEC §4.3).
struct Action {
    uint256 agentId;
    address target;
    uint256 value;
    bytes data;
    uint64 deadline;
    bytes32 salt;
}

/// @title ActionHash
/// @notice The single definition of the two hashes that bind a verdict to an action (SPEC §4.3,
/// ARCHITECTURE §4.3). The TypeScript SDK implements the same encoding (packages/sdk/src/action.ts),
/// and both are checked against the shared vectors in packages/sdk/test/vectors.json.
/// - `requestHash` is the ERC-8004 `requestHash` for one validator: the gate recomputes one per
///   trusted validator, because the registry allows one validator per `requestHash`.
/// - `actionHash` omits the validator. The gate marks it consumed, so an action runs at most once
///   however many validators judged it.
/// The ABI encoding is the "request payload" the EIP's `requestHash` commits to (spec-notes, row 6).
library ActionHash {
    function actionHash(Action calldata action, uint256 chainId, address gate) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                chainId,
                gate,
                action.agentId,
                action.target,
                action.value,
                keccak256(action.data),
                action.deadline,
                action.salt
            )
        );
    }

    function requestHash(Action calldata action, uint256 chainId, address gate, address validator)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                chainId,
                gate,
                validator,
                action.agentId,
                action.target,
                action.value,
                keccak256(action.data),
                action.deadline,
                action.salt
            )
        );
    }
}
