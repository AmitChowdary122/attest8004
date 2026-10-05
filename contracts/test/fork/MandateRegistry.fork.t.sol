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

    DeployMandateRegistry internal script;
    MandateRegistry internal registry;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        script = new DeployMandateRegistry();
        // A fresh registry with the deploy script's constructor arguments, created with `new` rather
        // than `script.deploy`: deploy is idempotent, so once v2 is live at the CREATE2 address it
        // would return the live contract, whose agent 1984 already has its (once-only) passkey.
        registry = new MandateRegistry(script.configFor(10143), script.RP_ID_HASH());
        passkey = _signer("fork passkey");
    }

    /// The script's testnet deployment (the live one once deployed, else a fork-local deploy) is
    /// wired to the canonical Identity Registry and our rpIdHash.
    function testFork_DeployedWithTheRpIdHash() public {
        MandateRegistry deployed = script.deploy(script.configFor(10143));
        assertEq(deployed.rpIdHash(), RP_ID_HASH);
        assertEq(address(deployed.identityRegistry()), address(IDENTITY));
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

    function testFork_OwnerWithAnotherKeysAssertionRefused() public {
        address owner = IDENTITY.ownerOf(AGENT_ID);
        vm.prank(owner);
        registry.setPasskey(AGENT_ID, passkey.qx, passkey.qy);
        MandateRegistry.Mandate memory mandate = _validMandate(owner);
        WebAuthn.WebAuthnAuth memory auth = _assert(_signer("not the passkey"), _challengeFor(mandate));

        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.InvalidAssertion.selector, AGENT_ID));
        vm.prank(owner);
        registry.setMandate(AGENT_ID, mandate, auth);
    }

    /// The basis of scripts' SET_INBOX_KEY_GAS_CAP (approval-plan.ts): setInboxKey for live agent 1984 against the
    /// canonical Identity Registry (a proxy, so ownerOf costs ~27k in-frame), as it runs live: after a mandate (the
    /// nonce goes nonzero to nonzero), the inbox key's first set, Chrome's extra clientDataJSON key. Logs the frame gas
    /// plus the 21,000 intrinsic gas and the calldata's cost; the cap is that total × 1.3.
    function testFork_Gas_SetInboxKey() public {
        address owner = IDENTITY.ownerOf(AGENT_ID);
        vm.prank(owner);
        registry.setPasskey(AGENT_ID, passkey.qx, passkey.qy);
        MandateRegistry.Mandate memory mandate = _validMandate(owner);
        WebAuthn.WebAuthnAuth memory mandateAuth = _approval(mandate);
        vm.prank(owner);
        registry.setMandate(AGENT_ID, mandate, mandateAuth);

        bytes32 inboxKey = keccak256("fork inbox key");
        bytes32 changeHash = keccak256(abi.encode(registry.SET_INBOX_KEY(), inboxKey));
        bytes32 challenge =
            sha256(abi.encode(block.chainid, address(registry), AGENT_ID, changeHash, registry.nonceOf(AGENT_ID)));
        WebAuthn.WebAuthnAuth memory auth = _assertWith(
            passkey, challenge, AssertOpts({flags: FLAGS_SYNCED_UV, rpIdHash: RP_ID_HASH, highS: false, extraKey: true})
        );
        bytes memory data = abi.encodeCall(MandateRegistry.setInboxKey, (AGENT_ID, inboxKey, auth));
        uint256 calldataGas;
        for (uint256 i; i < data.length; ++i) {
            calldataGas += data[i] == 0 ? 4 : 16;
        }

        vm.prank(owner);
        uint256 before = gasleft();
        registry.setInboxKey(AGENT_ID, inboxKey, auth);
        uint256 frame = before - gasleft();

        assertEq(registry.inboxKeyOf(AGENT_ID), inboxKey);
        assertEq(registry.nonceOf(AGENT_ID), 2);
        emit log_named_uint("setInboxKey frame gas", frame);
        emit log_named_uint("setInboxKey calldata gas", calldataGas);
        emit log_named_uint("setInboxKey total (frame + 21,000 + calldata)", frame + 21_000 + calldataGas);
        assertLt(frame + 21_000 + calldataGas, 200_000, "far above the expected ~130k: re-measure the cap");
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
