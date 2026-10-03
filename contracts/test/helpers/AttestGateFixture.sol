// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {ValidationRegistry} from "../../src/ValidationRegistry.sol";
import {AttestGate} from "../../src/AttestGate.sol";
import {DemoAgentVault} from "../../src/DemoAgentVault.sol";
import {Action} from "../../src/ActionHash.sol";
import {MockIdentityRegistry} from "../mocks/MockIdentityRegistry.sol";
import {MockTarget} from "../mocks/MockTarget.sol";

/// @notice Shared setup for the gate and vault tests: the real P1 ValidationRegistry on a mock
/// Identity Registry, agent 1 (owner) and agent 2 (attacker), and a vault for agent 1 that
/// requires validator A with a score of 100.
abstract contract AttestGateFixture is Test {
    MockIdentityRegistry internal identity;
    ValidationRegistry internal registry;
    MockTarget internal target;
    DemoAgentVault internal vault;

    address internal owner = makeAddr("owner");
    address internal attacker = makeAddr("attacker");
    address internal stranger = makeAddr("stranger");
    address internal validatorA = makeAddr("validatorA");
    address internal validatorB = makeAddr("validatorB");
    address internal validatorC = makeAddr("validatorC");

    uint256 internal agentId;
    uint256 internal attackerAgentId;

    uint256 internal constant VAULT_BALANCE = 10 ether;

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        identity = new MockIdentityRegistry();
        registry = new ValidationRegistry(address(identity));
        vm.prank(owner);
        agentId = identity.register();
        vm.prank(attacker);
        attackerAgentId = identity.register();
        target = new MockTarget();
        vault = _vault(_reqs(validatorA, 100));
    }

    function _vault(AttestGate.Requirement[] memory reqs) internal returns (DemoAgentVault v) {
        v = new DemoAgentVault(address(registry), agentId, reqs);
        vm.deal(address(v), VAULT_BALANCE);
    }

    function _reqs(address v, uint8 minScore) internal pure returns (AttestGate.Requirement[] memory r) {
        r = new AttestGate.Requirement[](1);
        r[0] = AttestGate.Requirement(v, minScore);
    }

    function _reqs(address v1, uint8 min1, address v2, uint8 min2)
        internal
        pure
        returns (AttestGate.Requirement[] memory r)
    {
        r = new AttestGate.Requirement[](2);
        r[0] = AttestGate.Requirement(v1, min1);
        r[1] = AttestGate.Requirement(v2, min2);
    }

    /// 1 ether to MockTarget.ping(7), valid for an hour.
    function _action() internal view returns (Action memory) {
        return Action({
            agentId: agentId,
            target: address(target),
            value: 1 ether,
            data: abi.encodeCall(MockTarget.ping, (7)),
            deadline: uint64(block.timestamp + 1 hours),
            salt: keccak256("attest8004.test.salt")
        });
    }

    /// The agent's owner names `validator` for `gate`'s requestHash, then `validator` responds.
    function _validate(DemoAgentVault gate, Action memory a, address validator, uint8 score)
        internal
        returns (bytes32 rh)
    {
        rh = _requestOnly(gate, a, validator);
        _respond(validator, rh, score);
    }

    function _requestOnly(DemoAgentVault gate, Action memory a, address validator) internal returns (bytes32 rh) {
        rh = gate.requestHashOf(a, validator);
        _request(identity.ownerOf(a.agentId), a.agentId, validator, rh);
    }

    function _request(address caller, uint256 id, address namedValidator, bytes32 rh) internal {
        vm.prank(caller);
        registry.validationRequest(namedValidator, id, "data:application/json,{}", rh);
    }

    function _respond(address validator, bytes32 rh, uint8 score) internal {
        vm.prank(validator);
        registry.validationResponse(rh, score, "", bytes32(0), "test");
    }

    function _err(bytes4 selector, address validator, bytes32 rh) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(selector, validator, rh);
    }
}
