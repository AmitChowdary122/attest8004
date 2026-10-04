// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";
import {DeployMandateRegistry} from "../../script/DeployMandateRegistry.s.sol";
import {IERC8004IdentityRegistry} from "./ValidationRegistry.fork.t.sol";
import {WebAuthnFixture} from "../helpers/WebAuthnFixture.sol";

/// @notice MandateRegistry v2 against the canonical Identity Registry, on a fork of Monad testnet
/// (latest block), with the real P256 precompile. Skipped when MONAD_TESTNET_RPC_URL is unset.
contract MandateRegistryForkTest is WebAuthnFixture {
    IERC8004IdentityRegistry internal constant IDENTITY =
        IERC8004IdentityRegistry(0x8004A818BFB912233c491871b3d84c89A494BD9e);
    uint256 internal constant AGENT_ID = 1984;

    address internal stranger = makeAddr("stranger");
    Signer internal passkey;

    MandateRegistry internal registry;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        // A fresh v2 registry on the fork, configured exactly as the deploy script does.
        DeployMandateRegistry script = new DeployMandateRegistry();
        registry = script.deploy(script.configFor(10143));
        passkey = _signer("fork passkey");
    }

    function testFork_DeployedWithTheRpIdHash() public view {
        assertEq(registry.rpIdHash(), RP_ID_HASH);
        assertEq(address(registry.identityRegistry()), address(IDENTITY));
    }

    function testFork_OwnerAndPasskeyOfLiveAgentSetMandate() public {
        address owner = IDENTITY.ownerOf(AGENT_ID);
        vm.prank(owner);
        registry.setPasskey(AGENT_ID, passkey.qx, passkey.qy);

        MandateRegistry.Mandate memory mandate = _validMandate(owner);
        WebAuthn.WebAuthnAuth memory auth = _approval(mandate);
        vm.prank(owner);
        registry.setMandate(AGENT_ID, mandate, auth);

        (MandateRegistry.Mandate memory stored, bytes32 mandateHash, address recordedOwner,) =
            registry.getMandate(AGENT_ID);
        assertEq(mandateHash, registry.mandateHashOf(mandate));
        assertEq(recordedOwner, owner);
        assertEq(stored.maxValuePerTx, mandate.maxValuePerTx);
        assertEq(stored.maxValuePerDay, mandate.maxValuePerDay);
        assertEq(stored.validUntil, mandate.validUntil);
        assertEq(stored.allowedTargets.length, 1);
        assertEq(stored.allowedTargets[0], mandate.allowedTargets[0]);
        assertEq(stored.allowedSelectors.length, 1);
        assertEq(stored.allowedSelectors[0], mandate.allowedSelectors[0]);
        assertEq(registry.nonceOf(AGENT_ID), 1);
    }

    function testFork_StrangerRefused() public {
        address owner = IDENTITY.ownerOf(AGENT_ID);
        vm.prank(owner);
        registry.setPasskey(AGENT_ID, passkey.qx, passkey.qy);
        MandateRegistry.Mandate memory mandate = _validMandate(owner);
        WebAuthn.WebAuthnAuth memory auth = _approval(mandate);

        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.NotAgentOwner.selector, AGENT_ID, stranger));
        vm.prank(stranger);
        registry.setMandate(AGENT_ID, mandate, auth);
    }

    function testFork_OwnerWithoutPasskeyAssertionRefused() public {
        address owner = IDENTITY.ownerOf(AGENT_ID);
        vm.prank(owner);
        registry.setPasskey(AGENT_ID, passkey.qx, passkey.qy);
        MandateRegistry.Mandate memory mandate = _validMandate(owner);
        WebAuthn.WebAuthnAuth memory auth = _assert(_signer("not the passkey"), _challengeFor(mandate));

        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.InvalidAssertion.selector, AGENT_ID));
        vm.prank(owner);
        registry.setMandate(AGENT_ID, mandate, auth);
    }

    function _challengeFor(MandateRegistry.Mandate memory mandate) internal view returns (bytes32) {
        return sha256(
            abi.encode(
                block.chainid, address(registry), AGENT_ID, registry.mandateHashOf(mandate), registry.nonceOf(AGENT_ID)
            )
        );
    }

    function _approval(MandateRegistry.Mandate memory mandate) internal view returns (WebAuthn.WebAuthnAuth memory) {
        return _assert(passkey, _challengeFor(mandate));
    }

    function _validMandate(address target) internal view returns (MandateRegistry.Mandate memory mandate) {
        address[] memory targets = new address[](1);
        targets[0] = target;
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = bytes4(0x00000000);
        mandate = MandateRegistry.Mandate({
            allowedTargets: targets,
            allowedSelectors: selectors,
            maxValuePerTx: 0.001 ether,
            maxValuePerDay: 0.005 ether,
            validUntil: uint64(block.timestamp + 1 days)
        });
    }
}
