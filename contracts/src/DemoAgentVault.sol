// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {AttestGate} from "./AttestGate.sol";
import {Action} from "./ActionHash.sol";

/// @title DemoAgentVault
/// @notice Example AttestGate consumer (SPEC §4.3): holds test MON for one ERC-8004 agent, and
/// makes a call on the agent's behalf only when every required validator passed exactly that
/// action. There is no owner and no other way to move funds out.
/// @dev `execute` is permissionless: the validated, deadline-bound action is the authorisation,
/// whoever submits it. To cancel an action, let it expire. A failed call reverts the whole
/// execute, consumption included, so the action can be retried until its deadline.
contract DemoAgentVault is AttestGate {
    /// The only agent whose actions this vault executes.
    uint256 public immutable agentId;

    error NotVaultAgent(uint256 vaultAgentId, uint256 actionAgentId);
    error CallFailed(bytes returnData);

    constructor(address validationRegistry_, uint256 agentId_, Requirement[] memory requirements_)
        AttestGate(validationRegistry_, requirements_)
    {
        agentId = agentId_;
    }

    receive() external payable {}

    /// @notice Calls `action.target` with `action.value` and `action.data` from this vault.
    /// @return result The target's return data.
    function execute(Action calldata action)
        external
        nonReentrant
        onlyVaultAgent(action)
        onlyValidated(action)
        returns (bytes memory result)
    {
        bool ok;
        // forge-lint: disable-next-line(arbitrary-send-eth) -- the target and value are what the validators approved
        (ok, result) = action.target.call{value: action.value}(action.data);
        if (!ok) revert CallFailed(result);
    }

    modifier onlyVaultAgent(Action calldata action) {
        _checkVaultAgent(action);
        _;
    }

    function _checkVaultAgent(Action calldata action) private view {
        if (action.agentId != agentId) revert NotVaultAgent(agentId, action.agentId);
    }
}
