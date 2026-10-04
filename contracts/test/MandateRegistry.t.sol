// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MandateRegistryHookHarness} from "./mocks/MandateRegistryHookHarness.sol";
import {WebAuthnFixture} from "./helpers/WebAuthnFixture.sol";

/// @notice SPEC §4.2 (as built in P6): every mandate change needs two factors — the agent owner's
/// transaction and a WebAuthn assertion from the passkey bound to the agent, verified through the
/// P256 precompile at `0x0100` (OpenZeppelin 5.7's `WebAuthn`). The challenge is
/// `sha256(abi.encode(chainId, registry, agentId, changeHash, nonce))`; every test here computes it
/// independently of `challengeFor`, and `passkey-vectors.json` pins it against `cast`.
contract MandateRegistryTest is WebAuthnFixture {
    using stdJson for string;
    using stdStorage for StdStorage;

    string internal constant VECTORS = "../packages/sdk/test/passkey-vectors.json";
    address internal constant P256_PRECOMPILE = address(0x100);
    bytes32 internal constant ROTATE_TAG = keccak256("attest8004.MandateRegistry.rotatePasskey");
    bytes32 internal constant INBOX_TAG = keccak256("attest8004.MandateRegistry.setInboxKey");

    MockIdentityRegistry internal identity;
    MandateRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal newOwner = makeAddr("newOwner");
    address internal stranger = makeAddr("stranger");

    uint256 internal agent1;
    Signer internal passkey;
    Signer internal otherKey;

    event PasskeySet(uint256 indexed agentId, address indexed owner, bytes32 qx, bytes32 qy);
    event PasskeyRotated(
        uint256 indexed agentId, address indexed owner, bytes32 oldQx, bytes32 oldQy, bytes32 qx, bytes32 qy
    );
    event InboxKeySet(uint256 indexed agentId, address indexed owner, bytes32 x25519Pub);
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
        registry = new MandateRegistry(address(identity), RP_ID_HASH);
        passkey = _signer("passkey");
        otherKey = _signer("otherKey");

        vm.prank(owner);
        agent1 = identity.register();
    }

    // ----------------------------------------------------------- helpers

    /// The WebAuthn challenge, computed here rather than with `challengeFor`.
    function _challenge(uint256 chainId, address reg, uint256 agentId, bytes32 changeHash, uint256 nonce)
        internal
        pure
        returns (bytes32)
    {
        return sha256(abi.encode(chainId, reg, agentId, changeHash, nonce));
    }

    function _rotateHash(bytes32 qx, bytes32 qy) internal pure returns (bytes32) {
        return keccak256(abi.encode(ROTATE_TAG, qx, qy));
    }

    function _inboxHash(bytes32 x25519Pub) internal pure returns (bytes32) {
        return keccak256(abi.encode(INBOX_TAG, x25519Pub));
    }

    /// `signer`'s assertion over `changeHash` for `agentId` on `reg`, at the agent's current nonce.
    function _approveOn(MandateRegistry reg, Signer memory signer, uint256 agentId, bytes32 changeHash)
        internal
        view
        returns (WebAuthn.WebAuthnAuth memory)
    {
        return _assert(signer, _challenge(block.chainid, address(reg), agentId, changeHash, reg.nonceOf(agentId)));
    }

    function _approve(Signer memory signer, uint256 agentId, bytes32 changeHash)
        internal
        view
        returns (WebAuthn.WebAuthnAuth memory)
    {
        return _approveOn(registry, signer, agentId, changeHash);
    }

    function _setPasskey(uint256 agentId, Signer memory signer) internal {
        vm.prank(identity.ownerOf(agentId));
        registry.setPasskey(agentId, signer.qx, signer.qy);
    }

    /// Sets `mandate` with both factors: the agent's current owner and `passkey`.
    function _setMandate(uint256 agentId, MandateRegistry.Mandate memory mandate) internal {
        WebAuthn.WebAuthnAuth memory auth = _approve(passkey, agentId, registry.mandateHashOf(mandate));
        vm.prank(identity.ownerOf(agentId));
        registry.setMandate(agentId, mandate, auth);
    }

    /// `setMandate` as `caller` with `auth` reverts with exactly `err`, and the nonce doesn't move.
    function _expectSetMandateRevert(
        address caller,
        uint256 agentId,
        MandateRegistry.Mandate memory mandate,
        WebAuthn.WebAuthnAuth memory auth,
        bytes memory err
    ) internal {
        uint256 nonceBefore = registry.nonceOf(agentId);
        vm.expectRevert(err);
        vm.prank(caller);
        registry.setMandate(agentId, mandate, auth);
        assertEq(registry.nonceOf(agentId), nonceBefore, "nonce moved");
    }

    function _expectInvalid(uint256 agentId, MandateRegistry.Mandate memory mandate, WebAuthn.WebAuthnAuth memory auth)
        internal
    {
        _expectSetMandateRevert(
            identity.ownerOf(agentId),
            agentId,
            mandate,
            auth,
            abi.encodeWithSelector(MandateRegistry.InvalidAssertion.selector, agentId)
        );
    }

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

    /// The logs `emitter` emitted (a test's own `emit`, for `vm.expectEmit`, is recorded too).
    function _logsOf(address emitter, Vm.Log[] memory all) internal pure returns (Vm.Log[] memory out) {
        uint256 n;
        for (uint256 i; i < all.length; ++i) {
            if (all[i].emitter == emitter) ++n;
        }
        out = new Vm.Log[](n);
        n = 0;
        for (uint256 i; i < all.length; ++i) {
            if (all[i].emitter == emitter) out[n++] = all[i];
        }
    }

    function _assertStoredMandate(uint256 agentId, MandateRegistry.Mandate memory expected) internal view {
        (MandateRegistry.Mandate memory stored, bytes32 storedHash,,) = registry.getMandate(agentId);
        assertEq(storedHash, registry.mandateHashOf(expected), "mandateHash");
        assertEq(stored.allowedTargets.length, expected.allowedTargets.length, "targets length");
        for (uint256 i; i < expected.allowedTargets.length; ++i) {
            assertEq(stored.allowedTargets[i], expected.allowedTargets[i], "target");
        }
        assertEq(stored.allowedSelectors.length, expected.allowedSelectors.length, "selectors length");
        for (uint256 i; i < expected.allowedSelectors.length; ++i) {
            assertEq(stored.allowedSelectors[i], expected.allowedSelectors[i], "selector");
        }
        assertEq(stored.maxValuePerTx, expected.maxValuePerTx, "maxValuePerTx");
        assertEq(stored.maxValuePerDay, expected.maxValuePerDay, "maxValuePerDay");
        assertEq(stored.validUntil, expected.validUntil, "validUntil");
    }

    // ----------------------------------------------------------- constructor

    function test_Constructor_RevertWhen_ZeroIdentityRegistry() public {
        bytes32 rpIdHash = RP_ID_HASH; // a sha256 precompile call; keep it out of the expected call
        vm.expectRevert(MandateRegistry.ZeroIdentityRegistry.selector);
        new MandateRegistry(address(0), rpIdHash);
    }

    function test_Constructor_RevertWhen_ZeroRpIdHash() public {
        vm.expectRevert(MandateRegistry.ZeroRpIdHash.selector);
        new MandateRegistry(address(identity), bytes32(0));
    }

    function test_Constructor_WiresImmutables() public view {
        assertEq(address(registry.identityRegistry()), address(identity), "identityRegistry");
        assertEq(registry.rpIdHash(), sha256("attest8004.vercel.app"), "rpIdHash");
        assertEq(registry.ROTATE_PASSKEY(), ROTATE_TAG, "ROTATE_PASSKEY");
        assertEq(registry.SET_INBOX_KEY(), INBOX_TAG, "SET_INBOX_KEY");
    }

    // ----------------------------------------------------------- setPasskey

    function test_SetPasskey_OwnerSetsOnce_EmitsPasskeySet() public {
        vm.expectEmit(address(registry));
        emit PasskeySet(agent1, owner, passkey.qx, passkey.qy);
        vm.prank(owner);
        registry.setPasskey(agent1, passkey.qx, passkey.qy);

        (bytes32 qx, bytes32 qy) = registry.passkeyOf(agent1);
        assertEq(qx, passkey.qx, "qx");
        assertEq(qy, passkey.qy, "qy");
        assertEq(registry.nonceOf(agent1), 0, "setPasskey doesn't use the nonce");

        // Once only: a second setPasskey, even with another valid key, is refused.
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.PasskeyAlreadySet.selector, agent1));
        vm.prank(owner);
        registry.setPasskey(agent1, otherKey.qx, otherKey.qy);
    }

    function test_SetPasskey_RevertWhen_NotOwner() public {
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.NotAgentOwner.selector, agent1, stranger));
        vm.prank(stranger);
        registry.setPasskey(agent1, passkey.qx, passkey.qy);

        // An operator or a token-approved address is not the owner either.
        address operator = makeAddr("operator");
        vm.prank(owner);
        identity.setApprovalForAll(operator, true);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.NotAgentOwner.selector, agent1, operator));
        vm.prank(operator);
        registry.setPasskey(agent1, passkey.qx, passkey.qy);

        address approved = makeAddr("approved");
        vm.prank(owner);
        identity.approve(approved, agent1);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.NotAgentOwner.selector, agent1, approved));
        vm.prank(approved);
        registry.setPasskey(agent1, passkey.qx, passkey.qy);

        (bytes32 qx, bytes32 qy) = registry.passkeyOf(agent1);
        assertEq(qx, bytes32(0));
        assertEq(qy, bytes32(0));
    }

    function test_SetPasskey_RevertWhen_AlreadySet() public {
        _setPasskey(agent1, passkey);

        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.PasskeyAlreadySet.selector, agent1));
        vm.prank(owner);
        registry.setPasskey(agent1, passkey.qx, passkey.qy);

        (bytes32 qx, bytes32 qy) = registry.passkeyOf(agent1);
        assertEq(qx, passkey.qx);
        assertEq(qy, passkey.qy);
    }

    function test_SetPasskey_RevertWhen_NotOnCurve() public {
        bytes32[2][4] memory bad = [
            [bytes32(0), bytes32(0)],
            [passkey.qx, bytes32(uint256(passkey.qy) + 1)],
            [bytes32(uint256(passkey.qx) ^ 1), passkey.qy],
            // The field modulus itself: out of range even though it reduces to a curve point's x.
            [bytes32(P256.P), passkey.qy]
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(MandateRegistry.InvalidPasskey.selector, bad[i][0], bad[i][1]));
            vm.prank(owner);
            registry.setPasskey(agent1, bad[i][0], bad[i][1]);
        }
        (bytes32 qx, bytes32 qy) = registry.passkeyOf(agent1);
        assertEq(qx, bytes32(0));
        assertEq(qy, bytes32(0));
    }

    // ----------------------------------------------------------- setMandate: happy path

    function test_SetMandate_OwnerAndPasskey_StoresEmitsAndBumpsNonce() public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        bytes32 hash = registry.mandateHashOf(mandate);
        uint64 expectedBlock = uint64(block.number);
        assertEq(registry.nonceOf(agent1), 0, "nonce before");
        assertEq(
            registry.challengeFor(agent1, hash, 0),
            _challenge(block.chainid, address(registry), agent1, hash, 0),
            "challengeFor"
        );
        WebAuthn.WebAuthnAuth memory auth = _approve(passkey, agent1, hash);

        vm.recordLogs();
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
        registry.setMandate(agent1, mandate, auth);

        Vm.Log[] memory logs = _logsOf(address(registry), vm.getRecordedLogs());
        assertEq(logs.length, 1, "one event");
        assertEq(logs[0].topics.length, 4, "topic0 + three indexed topics");
        assertEq(logs[0].topics[1], bytes32(agent1), "agentId topic");
        assertEq(logs[0].topics[2], hash, "mandateHash topic: exactly what the passkey approved");
        assertEq(logs[0].topics[3], bytes32(uint256(uint160(owner))), "owner topic");

        _assertStoredMandate(agent1, mandate);
        (, bytes32 storedHash, address storedOwner, uint64 setAtBlock) = registry.getMandate(agent1);
        assertEq(storedHash, hash, "mandateHash");
        assertEq(storedOwner, owner, "owner");
        assertEq(setAtBlock, expectedBlock, "setAtBlock");
        assertEq(registry.nonceOf(agent1), 1, "nonce after");
    }

    /// Chrome sometimes appends `"other_keys_can_be_added_here"`; the indices handle it.
    function test_SetMandate_AcceptsExtraClientDataKey() public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        bytes32 hash = registry.mandateHashOf(mandate);
        WebAuthn.WebAuthnAuth memory auth = _assertWith(
            passkey,
            _challenge(block.chainid, address(registry), agent1, hash, 0),
            AssertOpts({flags: FLAGS_SYNCED_UV, rpIdHash: RP_ID_HASH, highS: false, extraKey: true})
        );
        assertGt(_indexOf(bytes(auth.clientDataJSON), bytes("other_keys_can_be_added_here")), 0, "extra key present");

        vm.prank(owner);
        registry.setMandate(agent1, mandate, auth);
        (, bytes32 storedHash,,) = registry.getMandate(agent1);
        assertEq(storedHash, hash);
        assertEq(registry.nonceOf(agent1), 1);
    }

    // ----------------------------------------------------------- setMandate: the assertion

    function test_SetMandate_RevertWhen_WrongChallenge() public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        bytes32 hash = registry.mandateHashOf(mandate);
        MandateRegistry.Mandate memory other = _validMandate();
        other.maxValuePerTx = 0.5 ether;
        bytes32 otherHash = registry.mandateHashOf(other);
        uint256 chainId = vm.getChainId();
        address reg = address(registry);

        // changeHash: an approval of a different mandate.
        _expectInvalid(agent1, mandate, _assert(passkey, _challenge(chainId, reg, agent1, otherHash, 0)));
        // agentId.
        _expectInvalid(agent1, mandate, _assert(passkey, _challenge(chainId, reg, agent1 + 1, hash, 0)));
        // nonce.
        _expectInvalid(agent1, mandate, _assert(passkey, _challenge(chainId, reg, agent1, hash, 1)));
        // chain id: signed for another chain ...
        _expectInvalid(agent1, mandate, _assert(passkey, _challenge(143, reg, agent1, hash, 0)));
        // ... and a correct approval submitted on another chain.
        WebAuthn.WebAuthnAuth memory correct = _assert(passkey, _challenge(chainId, reg, agent1, hash, 0));
        vm.chainId(143);
        _expectInvalid(agent1, mandate, correct);
        vm.chainId(chainId);
        // registry address: an approval for another MandateRegistry.
        _expectInvalid(agent1, mandate, _assert(passkey, _challenge(chainId, address(0xBEEF), agent1, hash, 0)));

        // The control: the correct challenge passes.
        vm.prank(owner);
        registry.setMandate(agent1, mandate, correct);
        assertEq(registry.nonceOf(agent1), 1);
    }

    function test_SetMandate_RevertWhen_Replayed() public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        WebAuthn.WebAuthnAuth memory auth = _approve(passkey, agent1, registry.mandateHashOf(mandate));

        vm.prank(owner);
        registry.setMandate(agent1, mandate, auth);
        assertEq(registry.nonceOf(agent1), 1);

        _expectInvalid(agent1, mandate, auth);
    }

    function test_SetMandate_RevertWhen_UvMissing() public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        bytes32 challenge = _challenge(block.chainid, address(registry), agent1, registry.mandateHashOf(mandate), 0);
        _expectInvalid(
            agent1,
            mandate,
            _assertWith(
                passkey, challenge, AssertOpts({flags: 0x01, rpIdHash: RP_ID_HASH, highS: false, extraKey: false})
            )
        );
    }

    function test_SetMandate_RevertWhen_UpMissing() public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        bytes32 challenge = _challenge(block.chainid, address(registry), agent1, registry.mandateHashOf(mandate), 0);
        _expectInvalid(
            agent1,
            mandate,
            _assertWith(
                passkey, challenge, AssertOpts({flags: 0x04, rpIdHash: RP_ID_HASH, highS: false, extraKey: false})
            )
        );
    }

    /// OpenZeppelin's WebAuthn leaves the rpIdHash to the caller; the registry checks it.
    function test_SetMandate_RevertWhen_RpIdHashForAnotherSite() public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        bytes32 challenge = _challenge(block.chainid, address(registry), agent1, registry.mandateHashOf(mandate), 0);
        bytes32 evil = sha256("evil.example");
        _expectSetMandateRevert(
            owner,
            agent1,
            mandate,
            _assertWith(
                passkey, challenge, AssertOpts({flags: FLAGS_SYNCED_UV, rpIdHash: evil, highS: false, extraKey: false})
            ),
            abi.encodeWithSelector(MandateRegistry.WrongRpIdHash.selector, RP_ID_HASH, evil)
        );
    }

    /// The precompile accepts both `s` and `n - s`; the registry (through `P256.verify`) only low-s.
    function test_SetMandate_RevertWhen_HighS() public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        bytes32 challenge = _challenge(block.chainid, address(registry), agent1, registry.mandateHashOf(mandate), 0);
        WebAuthn.WebAuthnAuth memory auth = _assertWith(
            passkey, challenge, AssertOpts({flags: FLAGS_SYNCED_UV, rpIdHash: RP_ID_HASH, highS: true, extraKey: false})
        );
        assertGt(uint256(auth.s), P256.N / 2, "high s");
        _expectInvalid(agent1, mandate, auth);

        // The same signature, flipped to low-s, passes.
        auth.s = bytes32(P256.N - uint256(auth.s));
        vm.prank(owner);
        registry.setMandate(agent1, mandate, auth);
        assertEq(registry.nonceOf(agent1), 1);
    }

    // ----------------------------------------------------------- setMandate: the precompile's empty return

    /// With every `0x100` answer empty, OpenZeppelin treats the precompile as absent and verifies in
    /// Solidity: a valid assertion still passes and an invalid one is still refused, so an empty
    /// answer is never taken as success.
    function test_SetMandate_EmptyPrecompileReturn_NeverSucceeds() public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        WebAuthn.WebAuthnAuth memory auth = _approve(passkey, agent1, registry.mandateHashOf(mandate));
        WebAuthn.WebAuthnAuth memory wrongKey = _approve(otherKey, agent1, registry.mandateHashOf(mandate));
        bytes32 digest = _digest(auth.authenticatorData, auth.clientDataJSON);

        vm.mockCall(P256_PRECOMPILE, bytes(""), bytes(""));

        _expectInvalid(agent1, mandate, wrongKey);

        vm.expectCall(P256_PRECOMPILE, abi.encodePacked(digest, auth.r, auth.s, passkey.qx, passkey.qy));
        vm.prank(owner);
        registry.setMandate(agent1, mandate, auth);
        assertEq(registry.nonceOf(agent1), 1);
    }

    /// The precompile answers OpenZeppelin's probe (so it's present) but returns empty for our
    /// signature: that is an invalid signature, even though the signature is in fact valid.
    function test_SetMandate_RevertWhen_PrecompilePresentButReturnsEmpty() public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        WebAuthn.WebAuthnAuth memory auth = _approve(passkey, agent1, registry.mandateHashOf(mandate));
        bytes32 digest = _digest(auth.authenticatorData, auth.clientDataJSON);
        bytes memory probe = abi.encodePacked(
            bytes32(0xbb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca605023), // sha256("123400")
            bytes32(uint256(5)),
            bytes32(uint256(1)),
            bytes32(0xa71af64de5126a4a4e02b7922d66ce9415ce88a4c9d25514d91082c8725ac957),
            bytes32(0x5d47723c8fbe580bb369fec9c2665d8e30a435b9932645482e7c9f11e872296b)
        );

        vm.mockCall(P256_PRECOMPILE, bytes(""), bytes(""));
        vm.mockCall(P256_PRECOMPILE, probe, abi.encode(uint256(1)));

        vm.expectCall(P256_PRECOMPILE, abi.encodePacked(digest, auth.r, auth.s, passkey.qx, passkey.qy));
        vm.expectCall(P256_PRECOMPILE, probe);
        _expectInvalid(agent1, mandate, auth);
    }

    // ----------------------------------------------------------- setMandate: two factors

    function test_SetMandate_RevertWhen_NonOwnerWithValidAssertion() public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        WebAuthn.WebAuthnAuth memory auth = _approve(passkey, agent1, registry.mandateHashOf(mandate));

        _expectSetMandateRevert(
            stranger,
            agent1,
            mandate,
            auth,
            abi.encodeWithSelector(MandateRegistry.NotAgentOwner.selector, agent1, stranger)
        );

        address operator = makeAddr("operator");
        vm.prank(owner);
        identity.setApprovalForAll(operator, true);
        _expectSetMandateRevert(
            operator,
            agent1,
            mandate,
            auth,
            abi.encodeWithSelector(MandateRegistry.NotAgentOwner.selector, agent1, operator)
        );

        address approved = makeAddr("approved");
        vm.prank(owner);
        identity.approve(approved, agent1);
        _expectSetMandateRevert(
            approved,
            agent1,
            mandate,
            auth,
            abi.encodeWithSelector(MandateRegistry.NotAgentOwner.selector, agent1, approved)
        );

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 999));
        vm.prank(owner);
        registry.setMandate(999, mandate, auth);
    }

    function test_SetMandate_RevertWhen_NoPasskey() public {
        MandateRegistry.Mandate memory mandate = _validMandate();
        _expectSetMandateRevert(
            owner,
            agent1,
            mandate,
            _approve(passkey, agent1, registry.mandateHashOf(mandate)),
            abi.encodeWithSelector(MandateRegistry.NoPasskey.selector, agent1)
        );
    }

    function test_SetMandate_RevertWhen_OwnerWithInvalidAssertion() public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        bytes32 hash = registry.mandateHashOf(mandate);

        // Another key's (otherwise perfect) signature.
        _expectInvalid(agent1, mandate, _approve(otherKey, agent1, hash));

        // Garbage r/s: out of range, zero, and in range but wrong.
        WebAuthn.WebAuthnAuth memory garbage = _approve(passkey, agent1, hash);
        garbage.r = bytes32(type(uint256).max);
        _expectInvalid(agent1, mandate, garbage);
        garbage = _approve(passkey, agent1, hash);
        garbage.s = bytes32(0);
        _expectInvalid(agent1, mandate, garbage);
        garbage = _approve(passkey, agent1, hash);
        (garbage.r, garbage.s) = (keccak256("r"), bytes32(uint256(keccak256("s")) % (P256.N / 2)));
        _expectInvalid(agent1, mandate, garbage);

        // An all-empty struct.
        WebAuthn.WebAuthnAuth memory empty;
        _expectInvalid(agent1, mandate, empty);

        // authenticatorData shorter than 37 bytes, even when it starts with the right rpIdHash.
        WebAuthn.WebAuthnAuth memory short = _approve(passkey, agent1, hash);
        short.authenticatorData = abi.encodePacked(RP_ID_HASH, FLAGS_SYNCED_UV, bytes3(0));
        assertEq(short.authenticatorData.length, 36);
        _expectInvalid(agent1, mandate, short);
        short.authenticatorData = hex"00";
        _expectInvalid(agent1, mandate, short);
    }

    // ----------------------------------------------------------- rotatePasskey

    function test_RotatePasskey_WithCurrentPasskey() public {
        _setPasskey(agent1, passkey);
        Signer memory next = _signer("nextPasskey");
        WebAuthn.WebAuthnAuth memory auth = _approve(passkey, agent1, _rotateHash(next.qx, next.qy));

        vm.expectEmit(address(registry));
        emit PasskeyRotated(agent1, owner, passkey.qx, passkey.qy, next.qx, next.qy);
        vm.prank(owner);
        registry.rotatePasskey(agent1, next.qx, next.qy, auth);

        (bytes32 qx, bytes32 qy) = registry.passkeyOf(agent1);
        assertEq(qx, next.qx, "qx");
        assertEq(qy, next.qy, "qy");
        assertEq(registry.nonceOf(agent1), 1, "nonce");

        // The old key no longer approves anything; the new one does.
        MandateRegistry.Mandate memory mandate = _validMandate();
        bytes32 hash = registry.mandateHashOf(mandate);
        _expectInvalid(agent1, mandate, _approve(passkey, agent1, hash));
        WebAuthn.WebAuthnAuth memory byNext = _approve(next, agent1, hash);
        vm.prank(owner);
        registry.setMandate(agent1, mandate, byNext);
        assertEq(registry.nonceOf(agent1), 2);
    }

    function test_RotatePasskey_RevertWhen_SignedByNewKey() public {
        _setPasskey(agent1, passkey);
        Signer memory next = _signer("nextPasskey");
        WebAuthn.WebAuthnAuth memory auth = _approve(next, agent1, _rotateHash(next.qx, next.qy));
        _expectRotateRevert(
            owner, next, auth, abi.encodeWithSelector(MandateRegistry.InvalidAssertion.selector, agent1)
        );
    }

    function test_RotatePasskey_RevertWhen_SignedByStranger() public {
        _setPasskey(agent1, passkey);
        Signer memory next = _signer("nextPasskey");
        WebAuthn.WebAuthnAuth memory auth = _approve(otherKey, agent1, _rotateHash(next.qx, next.qy));
        _expectRotateRevert(
            owner, next, auth, abi.encodeWithSelector(MandateRegistry.InvalidAssertion.selector, agent1)
        );
    }

    function test_RotatePasskey_RevertWhen_NotOwner() public {
        _setPasskey(agent1, passkey);
        Signer memory next = _signer("nextPasskey");
        WebAuthn.WebAuthnAuth memory auth = _approve(passkey, agent1, _rotateHash(next.qx, next.qy));
        _expectRotateRevert(
            stranger, next, auth, abi.encodeWithSelector(MandateRegistry.NotAgentOwner.selector, agent1, stranger)
        );
    }

    function test_RotatePasskey_RevertWhen_NewKeyNotOnCurve() public {
        _setPasskey(agent1, passkey);
        bytes32[2][2] memory bad = [[bytes32(0), bytes32(0)], [otherKey.qx, bytes32(uint256(otherKey.qy) + 1)]];
        for (uint256 i; i < bad.length; ++i) {
            // A valid approval of exactly this (bad) key: only the curve check refuses it.
            WebAuthn.WebAuthnAuth memory auth = _approve(passkey, agent1, _rotateHash(bad[i][0], bad[i][1]));
            vm.expectRevert(abi.encodeWithSelector(MandateRegistry.InvalidPasskey.selector, bad[i][0], bad[i][1]));
            vm.prank(owner);
            registry.rotatePasskey(agent1, bad[i][0], bad[i][1], auth);
        }
        (bytes32 qx, bytes32 qy) = registry.passkeyOf(agent1);
        assertEq(qx, passkey.qx);
        assertEq(qy, passkey.qy);
        assertEq(registry.nonceOf(agent1), 0);
    }

    function _expectRotateRevert(
        address caller,
        Signer memory next,
        WebAuthn.WebAuthnAuth memory auth,
        bytes memory err
    ) internal {
        vm.expectRevert(err);
        vm.prank(caller);
        registry.rotatePasskey(agent1, next.qx, next.qy, auth);
        (bytes32 qx, bytes32 qy) = registry.passkeyOf(agent1);
        assertEq(qx, passkey.qx, "passkey unchanged");
        assertEq(qy, passkey.qy, "passkey unchanged");
        assertEq(registry.nonceOf(agent1), 0, "nonce moved");
    }

    // ----------------------------------------------------------- transfer

    /// The passkey is bound to the agent, not to its owner: a new owner can't replace it, and
    /// needs it for every change; the old owner, still holding it, can't use it.
    function test_Passkey_SurvivesTransfer() public {
        _setPasskey(agent1, passkey);
        vm.prank(owner);
        identity.transferFrom(owner, newOwner, agent1);

        (bytes32 qx, bytes32 qy) = registry.passkeyOf(agent1);
        assertEq(qx, passkey.qx, "passkey survives the transfer");
        assertEq(qy, passkey.qy, "passkey survives the transfer");

        Signer memory buyerKey = _signer("buyerKey");
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.PasskeyAlreadySet.selector, agent1));
        vm.prank(newOwner);
        registry.setPasskey(agent1, buyerKey.qx, buyerKey.qy);

        MandateRegistry.Mandate memory mandate = _validMandate();
        WebAuthn.WebAuthnAuth memory auth = _approve(passkey, agent1, registry.mandateHashOf(mandate));
        _expectSetMandateRevert(
            owner, agent1, mandate, auth, abi.encodeWithSelector(MandateRegistry.NotAgentOwner.selector, agent1, owner)
        );

        vm.prank(newOwner);
        registry.setMandate(agent1, mandate, auth);
        (,, address recordedOwner,) = registry.getMandate(agent1);
        assertEq(recordedOwner, newOwner);
        assertEq(registry.nonceOf(agent1), 1);
    }

    // ----------------------------------------------------------- revokeMandate

    /// The panic button: owner only, no passkey, and it bumps the nonce so every approval that was
    /// signed but not yet submitted dies with the mandate.
    function test_RevokeMandate_OwnerOnlyNoPasskey_BumpsNonce() public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        bytes32 hash = registry.mandateHashOf(mandate);
        _setMandate(agent1, mandate);
        assertEq(registry.nonceOf(agent1), 1);

        // An approval signed at nonce 1, not yet submitted.
        MandateRegistry.Mandate memory pending = _validMandate();
        pending.allowedTargets = _addresses(5);
        WebAuthn.WebAuthnAuth memory pendingAuth = _approve(passkey, agent1, registry.mandateHashOf(pending));

        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.NotAgentOwner.selector, agent1, stranger));
        vm.prank(stranger);
        registry.revokeMandate(agent1);
        assertEq(registry.nonceOf(agent1), 1, "a refused revoke doesn't move the nonce");

        vm.expectEmit(address(registry));
        emit MandateRevoked(agent1, hash, owner);
        vm.prank(owner);
        registry.revokeMandate(agent1);
        assertEq(registry.nonceOf(agent1), 2, "revoke bumps the nonce");

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
        (bytes32 qx, bytes32 qy) = registry.passkeyOf(agent1);
        assertEq(qx, passkey.qx, "the passkey stays");
        assertEq(qy, passkey.qy, "the passkey stays");

        // The approval signed before the revoke can't reinstate anything.
        _expectInvalid(agent1, pending, pendingAuth);

        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.NoMandate.selector, agent1));
        vm.prank(owner);
        registry.revokeMandate(agent1);
        assertEq(registry.nonceOf(agent1), 2);
    }

    // ----------------------------------------------------------- setInboxKey

    function test_SetInboxKey_TwoFactor_EmitsInboxKeySet() public {
        _setPasskey(agent1, passkey);
        bytes32 x25519Pub = keccak256("x25519 public key");
        WebAuthn.WebAuthnAuth memory auth = _approve(passkey, agent1, _inboxHash(x25519Pub));

        vm.expectEmit(address(registry));
        emit InboxKeySet(agent1, owner, x25519Pub);
        vm.prank(owner);
        registry.setInboxKey(agent1, x25519Pub, auth);

        assertEq(registry.inboxKeyOf(agent1), x25519Pub);
        assertEq(registry.nonceOf(agent1), 1);

        // Replacing it needs a fresh approval.
        bytes32 nextPub = keccak256("next x25519 public key");
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.InvalidAssertion.selector, agent1));
        vm.prank(owner);
        registry.setInboxKey(agent1, nextPub, auth);
        auth = _approve(passkey, agent1, _inboxHash(nextPub));
        vm.prank(owner);
        registry.setInboxKey(agent1, nextPub, auth);
        assertEq(registry.inboxKeyOf(agent1), nextPub);
        assertEq(registry.nonceOf(agent1), 2);
    }

    function test_SetInboxKey_RevertWhen_Zero() public {
        _setPasskey(agent1, passkey);
        WebAuthn.WebAuthnAuth memory auth = _approve(passkey, agent1, _inboxHash(bytes32(0)));

        vm.expectRevert(MandateRegistry.ZeroInboxKey.selector);
        vm.prank(owner);
        registry.setInboxKey(agent1, bytes32(0), auth);
        assertEq(registry.nonceOf(agent1), 0);
    }

    function test_SetInboxKey_RevertWhen_NonOwner() public {
        _setPasskey(agent1, passkey);
        bytes32 x25519Pub = keccak256("x25519 public key");
        WebAuthn.WebAuthnAuth memory auth = _approve(passkey, agent1, _inboxHash(x25519Pub));

        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.NotAgentOwner.selector, agent1, stranger));
        vm.prank(stranger);
        registry.setInboxKey(agent1, x25519Pub, auth);
        assertEq(registry.inboxKeyOf(agent1), bytes32(0));
        assertEq(registry.nonceOf(agent1), 0);
    }

    // ----------------------------------------------------------- cross binding

    function test_Assertion_CannotCrossOperations() public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        bytes32 mandateHash = registry.mandateHashOf(mandate);
        Signer memory next = _signer("nextPasskey");
        bytes32 x25519Pub = keccak256("x25519 public key");
        bytes4 invalid = MandateRegistry.InvalidAssertion.selector;

        WebAuthn.WebAuthnAuth memory forMandate = _approve(passkey, agent1, mandateHash);
        WebAuthn.WebAuthnAuth memory forRotate = _approve(passkey, agent1, _rotateHash(next.qx, next.qy));
        WebAuthn.WebAuthnAuth memory forInbox = _approve(passkey, agent1, _inboxHash(x25519Pub));

        // A setMandate approval can't set an inbox key or rotate the passkey ...
        vm.expectRevert(abi.encodeWithSelector(invalid, agent1));
        vm.prank(owner);
        registry.setInboxKey(agent1, x25519Pub, forMandate);
        vm.expectRevert(abi.encodeWithSelector(invalid, agent1));
        vm.prank(owner);
        registry.rotatePasskey(agent1, next.qx, next.qy, forMandate);

        // ... and the reverse.
        _expectInvalid(agent1, mandate, forInbox);
        _expectInvalid(agent1, mandate, forRotate);

        // Nor can a rotation approval set the inbox key, or the other way round.
        vm.expectRevert(abi.encodeWithSelector(invalid, agent1));
        vm.prank(owner);
        registry.setInboxKey(agent1, x25519Pub, forRotate);
        vm.expectRevert(abi.encodeWithSelector(invalid, agent1));
        vm.prank(owner);
        registry.rotatePasskey(agent1, next.qx, next.qy, forInbox);

        assertEq(registry.nonceOf(agent1), 0, "nothing landed");
        // Each one still works for its own operation.
        vm.prank(owner);
        registry.setMandate(agent1, mandate, forMandate);
    }

    function test_Assertion_CannotCrossAgents() public {
        vm.prank(owner);
        uint256 agent2 = identity.register();
        _setPasskey(agent1, passkey);
        _setPasskey(agent2, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();

        WebAuthn.WebAuthnAuth memory forAgent1 = _approve(passkey, agent1, registry.mandateHashOf(mandate));
        _expectInvalid(agent2, mandate, forAgent1);

        vm.prank(owner);
        registry.setMandate(agent1, mandate, forAgent1);
        assertEq(registry.nonceOf(agent1), 1);
        assertEq(registry.nonceOf(agent2), 0, "nonces are per agent");
    }

    // ----------------------------------------------------------- the _authorize hook

    /// Every passkey-approved change goes through `_authorize`, with its own `changeHash`, before
    /// any write; and a vetoed change writes nothing.
    function test_Hook_EveryPasskeyChangeGoesThroughAuthorizeBeforeAnyWrite() public {
        MandateRegistryHookHarness harness = new MandateRegistryHookHarness(address(identity), RP_ID_HASH);
        vm.prank(owner);
        harness.setPasskey(agent1, passkey.qx, passkey.qy);
        assertEq(harness.authorizeCalls(), 0, "setPasskey is owner-only");

        Signer memory current = _hookSeesEachChangeBeforeItsWrite(harness);
        _hookVetoWritesNothing(harness, current);
    }

    /// Each of the three, twice where the previous value matters: `_authorize` gets the operation's
    /// own `changeHash` and sees the state before this call's write. Returns the rotated-to passkey.
    function _hookSeesEachChangeBeforeItsWrite(MandateRegistryHookHarness harness) internal returns (Signer memory) {
        // setMandate, then an overwrite.
        MandateRegistry.Mandate memory first = _validMandate();
        bytes32 firstHash = harness.mandateHashOf(first);
        WebAuthn.WebAuthnAuth memory auth = _approveOn(harness, passkey, agent1, firstHash);
        vm.prank(owner);
        harness.setMandate(agent1, first, auth);
        assertEq(harness.authorizeCalls(), 1);
        assertEq(harness.lastAgentId(), agent1);
        assertEq(harness.lastChangeHash(), firstHash, "setMandate authorizes the mandateHash");
        assertEq(harness.mandateHashBeforeWrite(), bytes32(0), "saw the empty record");
        assertEq(harness.nonceBeforeWrite(), 0);

        MandateRegistry.Mandate memory second = _validMandate();
        second.allowedTargets = _addresses(3);
        bytes32 secondHash = harness.mandateHashOf(second);
        auth = _approveOn(harness, passkey, agent1, secondHash);
        vm.prank(owner);
        harness.setMandate(agent1, second, auth);
        assertEq(harness.lastChangeHash(), secondHash);
        assertEq(harness.mandateHashBeforeWrite(), firstHash, "saw the previous mandate, not the new one");
        assertEq(harness.nonceBeforeWrite(), 1);

        // setInboxKey, twice.
        bytes32 pub1 = keccak256("pub1");
        auth = _approveOn(harness, passkey, agent1, _inboxHash(pub1));
        vm.prank(owner);
        harness.setInboxKey(agent1, pub1, auth);
        assertEq(harness.lastChangeHash(), _inboxHash(pub1), "setInboxKey authorizes its tagged hash");
        assertEq(harness.inboxKeyBeforeWrite(), bytes32(0));
        bytes32 pub2 = keccak256("pub2");
        auth = _approveOn(harness, passkey, agent1, _inboxHash(pub2));
        vm.prank(owner);
        harness.setInboxKey(agent1, pub2, auth);
        assertEq(harness.inboxKeyBeforeWrite(), pub1, "saw the previous inbox key");
        assertEq(harness.nonceBeforeWrite(), 3);

        // rotatePasskey.
        Signer memory next = _signer("nextPasskey");
        auth = _approveOn(harness, passkey, agent1, _rotateHash(next.qx, next.qy));
        vm.prank(owner);
        harness.rotatePasskey(agent1, next.qx, next.qy, auth);
        assertEq(harness.authorizeCalls(), 5);
        assertEq(harness.lastChangeHash(), _rotateHash(next.qx, next.qy), "rotatePasskey authorizes its tagged hash");
        assertEq(harness.passkeyQxBeforeWrite(), passkey.qx, "saw the previous passkey");
        assertEq(harness.passkeyQyBeforeWrite(), passkey.qy, "saw the previous passkey");
        assertEq(harness.nonceBeforeWrite(), 4);
        return next;
    }

    /// A veto: each of the three, with an otherwise valid approval from `current`, writes nothing.
    function _hookVetoWritesNothing(MandateRegistryHookHarness harness, Signer memory current) internal {
        (, bytes32 mandateHash,,) = harness.getMandate(agent1);
        bytes32 inboxKey = harness.inboxKeyOf(agent1);
        uint256 nonce = harness.nonceOf(agent1);
        uint256 calls = harness.authorizeCalls();
        harness.setShouldRevert(true);
        bytes memory veto = bytes("MandateRegistryHookHarness: reverted");

        MandateRegistry.Mandate memory third = _validMandate();
        third.allowedTargets = _addresses(5);
        WebAuthn.WebAuthnAuth memory auth = _approveOn(harness, current, agent1, harness.mandateHashOf(third));
        vm.expectRevert(veto);
        vm.prank(owner);
        harness.setMandate(agent1, third, auth);

        Signer memory last = _signer("lastPasskey");
        auth = _approveOn(harness, current, agent1, _rotateHash(last.qx, last.qy));
        vm.expectRevert(veto);
        vm.prank(owner);
        harness.rotatePasskey(agent1, last.qx, last.qy, auth);

        bytes32 pub3 = keccak256("pub3");
        auth = _approveOn(harness, current, agent1, _inboxHash(pub3));
        vm.expectRevert(veto);
        vm.prank(owner);
        harness.setInboxKey(agent1, pub3, auth);

        assertEq(harness.authorizeCalls(), calls, "a reverted call rolls back its own counter too");
        (, bytes32 mandateHashAfter,,) = harness.getMandate(agent1);
        assertEq(mandateHashAfter, mandateHash, "mandate untouched");
        (bytes32 qx, bytes32 qy) = harness.passkeyOf(agent1);
        assertEq(qx, current.qx, "passkey untouched");
        assertEq(qy, current.qy, "passkey untouched");
        assertEq(harness.inboxKeyOf(agent1), inboxKey, "inbox key untouched");
        assertEq(harness.nonceOf(agent1), nonce, "nonce untouched");
    }

    // ----------------------------------------------------------- fuzz

    /// An approval signed at nonce `m` is accepted when the stored nonce is `n` iff `m == n`. Both
    /// sides run every time: the approval at `m` fails unless `m == n`, and the one at `n` passes.
    function testFuzz_NonceBinding(uint64 n, uint64 m) public {
        _setPasskey(agent1, passkey);
        stdstore.target(address(registry)).sig(registry.nonceOf.selector).with_key(agent1).checked_write(uint256(n));
        assertEq(registry.nonceOf(agent1), n);

        MandateRegistry.Mandate memory mandate = _validMandate();
        bytes32 hash = registry.mandateHashOf(mandate);
        if (m != n) {
            _expectInvalid(
                agent1, mandate, _assert(passkey, _challenge(block.chainid, address(registry), agent1, hash, m))
            );
        }

        WebAuthn.WebAuthnAuth memory atN =
            _assert(passkey, _challenge(block.chainid, address(registry), agent1, hash, n));
        vm.prank(owner);
        registry.setMandate(agent1, mandate, atN);
        assertEq(registry.nonceOf(agent1), uint256(n) + 1);
    }

    /// A signature over a challenge with any of changeHash, agentId or chain id differing from the
    /// call fails — each field alone, and all of them at once.
    function testFuzz_ChallengeBinding(bytes32 changeHash, uint256 agentId, uint64 chainId) public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        bytes32 hash = registry.mandateHashOf(mandate);
        address reg = address(registry);
        uint256 here = block.chainid;

        if (changeHash != hash) {
            _expectInvalid(agent1, mandate, _assert(passkey, _challenge(here, reg, agent1, changeHash, 0)));
        }
        if (agentId != agent1) {
            _expectInvalid(agent1, mandate, _assert(passkey, _challenge(here, reg, agentId, hash, 0)));
        }
        if (chainId != here) {
            _expectInvalid(agent1, mandate, _assert(passkey, _challenge(chainId, reg, agent1, hash, 0)));
        }
        if (changeHash != hash || agentId != agent1 || chainId != here) {
            _expectInvalid(agent1, mandate, _assert(passkey, _challenge(chainId, reg, agentId, changeHash, 0)));
        }

        // The control: the call's own challenge passes.
        WebAuthn.WebAuthnAuth memory correct = _assert(passkey, _challenge(here, reg, agent1, hash, 0));
        vm.prank(owner);
        registry.setMandate(agent1, mandate, correct);
    }

    /// A wrong `typeIndex` or `challengeIndex`, however large, is `InvalidAssertion`, never a panic
    /// or an out-of-gas.
    function testFuzz_IndicesNeverPanic(uint256 typeIndex, uint256 challengeIndex) public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        WebAuthn.WebAuthnAuth memory auth = _approve(passkey, agent1, registry.mandateHashOf(mandate));
        uint256 goodType = auth.typeIndex;
        uint256 goodChallenge = auth.challengeIndex;

        if (typeIndex != goodType) {
            auth.typeIndex = typeIndex;
            _expectInvalid(agent1, mandate, auth);
            auth.typeIndex = goodType;
        }
        if (challengeIndex != goodChallenge) {
            auth.challengeIndex = challengeIndex;
            _expectInvalid(agent1, mandate, auth);
            auth.challengeIndex = goodChallenge;
        }
        if (typeIndex != goodType || challengeIndex != goodChallenge) {
            (auth.typeIndex, auth.challengeIndex) = (typeIndex, challengeIndex);
            _expectInvalid(agent1, mandate, auth);
        }

        // The control: the right indices pass.
        (auth.typeIndex, auth.challengeIndex) = (goodType, goodChallenge);
        vm.prank(owner);
        registry.setMandate(agent1, mandate, auth);
    }

    function testFuzz_MandateHashBindsEveryField(
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

    // ----------------------------------------------------------- P4's mandate rules, on v2

    function test_SetMandate_RevertWhen_Invalid() public {
        _setPasskey(agent1, passkey);

        MandateRegistry.Mandate memory expired = _validMandate();
        expired.validUntil = uint64(block.timestamp);
        _expectRule(
            expired,
            abi.encodeWithSelector(MandateRegistry.MandateAlreadyExpired.selector, expired.validUntil, block.timestamp)
        );

        MandateRegistry.Mandate memory manyTargets = _validMandate();
        manyTargets.allowedTargets = _addresses(17);
        _expectRule(manyTargets, abi.encodeWithSelector(MandateRegistry.TooManyTargets.selector, 17));

        MandateRegistry.Mandate memory manySelectors = _validMandate();
        manySelectors.allowedSelectors = _selectors(17);
        _expectRule(manySelectors, abi.encodeWithSelector(MandateRegistry.TooManySelectors.selector, 17));

        MandateRegistry.Mandate memory zeroTarget = _validMandate();
        zeroTarget.allowedTargets[0] = address(0);
        _expectRule(zeroTarget, abi.encodeWithSelector(MandateRegistry.ZeroTarget.selector));

        MandateRegistry.Mandate memory capInverted = _validMandate();
        capInverted.maxValuePerTx = 3 ether;
        capInverted.maxValuePerDay = 2 ether;
        _expectRule(capInverted, abi.encodeWithSelector(MandateRegistry.TxCapAboveDailyCap.selector, 3 ether, 2 ether));

        // Boundary values that must pass.
        MandateRegistry.Mandate memory justValid = _validMandate();
        justValid.validUntil = uint64(block.timestamp + 1);
        _setMandate(agent1, justValid);
        _assertStoredMandate(agent1, justValid);

        MandateRegistry.Mandate memory equalCaps = _validMandate();
        equalCaps.maxValuePerTx = 1 ether;
        equalCaps.maxValuePerDay = 1 ether;
        _setMandate(agent1, equalCaps);
        _assertStoredMandate(agent1, equalCaps);
    }

    /// A rule violation with an otherwise valid two-factor approval reverts with exactly `err`.
    function _expectRule(MandateRegistry.Mandate memory mandate, bytes memory err) internal {
        _expectSetMandateRevert(owner, agent1, mandate, _approve(passkey, agent1, registry.mandateHashOf(mandate)), err);
    }

    /// The passing side of the 16-entry caps.
    function test_SetMandate_ExactlyMaxTargetsAndSelectors_Passes() public {
        assertEq(registry.MAX_TARGETS(), 16, "MAX_TARGETS");
        assertEq(registry.MAX_SELECTORS(), 16, "MAX_SELECTORS");
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory full = _validMandate();
        full.allowedTargets = _addresses(16);
        full.allowedSelectors = _selectors(16);

        _setMandate(agent1, full);
        _assertStoredMandate(agent1, full);
    }

    function test_SetMandate_Overwrite_ReplacesArraysCompletely() public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory first = _validMandate();
        first.allowedTargets = _addresses(3);
        first.allowedSelectors = _selectors(3);
        _setMandate(agent1, first);

        MandateRegistry.Mandate memory second = _validMandate();
        second.allowedTargets = _addresses(1);
        second.allowedSelectors = _selectors(1);
        _setMandate(agent1, second);

        _assertStoredMandate(agent1, second);
        assertEq(registry.nonceOf(agent1), 2);
    }

    /// The record names the owner who set it; a transfer alone never rewrites it.
    function test_SetMandate_AfterTransfer_RecordKeepsSetterUntilReplaced() public {
        _setPasskey(agent1, passkey);
        MandateRegistry.Mandate memory mandate = _validMandate();
        _setMandate(agent1, mandate);
        (, bytes32 oldHash,, uint64 oldSetAtBlock) = registry.getMandate(agent1);

        vm.prank(owner);
        identity.transferFrom(owner, newOwner, agent1);

        (, bytes32 hashAfterTransfer, address ownerAfterTransfer, uint64 setAtBlockAfterTransfer) =
            registry.getMandate(agent1);
        assertEq(hashAfterTransfer, oldHash, "record untouched by transfer");
        assertEq(ownerAfterTransfer, owner, "still names the old owner");
        assertEq(setAtBlockAfterTransfer, oldSetAtBlock);

        MandateRegistry.Mandate memory second = _validMandate();
        second.allowedTargets = _addresses(1);
        _setMandate(agent1, second);
        (,, address ownerNow,) = registry.getMandate(agent1);
        assertEq(ownerNow, newOwner);
    }

    // ----------------------------------------------------------- shape

    /// `mandate-v1`, `risk-v1` and the indexer decode P4's and v2's events with one ABI.
    function test_Events_MandateSetAndRevokedKeepP4Signatures() public {
        bytes32 mandateSetTopic =
            keccak256("MandateSet(uint256,bytes32,address,address[],bytes4[],uint256,uint256,uint64,uint64)");
        bytes32 mandateRevokedTopic = keccak256("MandateRevoked(uint256,bytes32,address)");
        assertEq(MandateRegistry.MandateSet.selector, mandateSetTopic, "MandateSet");
        assertEq(MandateRegistry.MandateRevoked.selector, mandateRevokedTopic, "MandateRevoked");

        _setPasskey(agent1, passkey);
        vm.recordLogs();
        _setMandate(agent1, _validMandate());
        vm.prank(owner);
        registry.revokeMandate(agent1);
        Vm.Log[] memory logs = _logsOf(address(registry), vm.getRecordedLogs());
        assertEq(logs.length, 2);
        assertEq(logs[0].topics[0], mandateSetTopic, "emitted MandateSet topic0");
        assertEq(logs[1].topics[0], mandateRevokedTopic, "emitted MandateRevoked topic0");
        assertEq(logs[1].topics.length, 4, "MandateRevoked keeps three indexed topics");
    }

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

    // ----------------------------------------------------------- shared vectors

    /// `passkey-vectors.json` (expected values from cast and sha256sum, never from Solidity) pins the
    /// challenge, both tagged change hashes, the e2e mandate's hash, the selectors and the topics.
    function test_Vectors_MatchPasskeyVectorsJson() public {
        string memory json = vm.readFile(VECTORS);
        assertEq(json.readBytes32(".rpIdHash"), RP_ID_HASH, "rpIdHash");
        _checkChallengeVectors(json);
        _checkChangeHashVectors(json);
        _checkE2eMandateVector(json);
        _checkSelectorsAndTopics(json);
    }

    /// `challengeFor`, on each vector's chain and at each vector's registry address.
    function _checkChallengeVectors(string memory json) internal {
        uint256 here = vm.getChainId();
        uint256 n;
        while (vm.keyExistsJson(json, _at(".challenges", n, ""))) {
            address reg = json.readAddress(_at(".challenges", n, ".registry"));
            deployCodeTo("MandateRegistry.sol:MandateRegistry", abi.encode(address(identity), RP_ID_HASH), reg);
            vm.chainId(json.readUint(_at(".challenges", n, ".chainId")));
            assertEq(
                MandateRegistry(reg)
                    .challengeFor(
                        json.readUint(_at(".challenges", n, ".agentId")),
                        json.readBytes32(_at(".challenges", n, ".changeHash")),
                        json.readUint(_at(".challenges", n, ".nonce"))
                    ),
                json.readBytes32(_at(".challenges", n, ".expected")),
                json.readString(_at(".challenges", n, ".name"))
            );
            // The 43-character form clientDataJSON carries, computed by the script, not by OZ's Base64.
            assertEq(
                Base64.encodeURL(abi.encodePacked(json.readBytes32(_at(".challenges", n, ".expected")))),
                json.readString(_at(".challenges", n, ".challengeB64url")),
                "challengeB64url"
            );
            ++n;
        }
        vm.chainId(here);
        assertGe(n, 5, "challenge vector count");
    }

    /// The change hashes: a two-factor call succeeds only if the registry's own change hash is
    /// exactly the vector's (the passkey signs the vector's value, not one computed here).
    function _checkChangeHashVectors(string memory json) internal {
        assertEq(json.readBytes32(".rotateChangeHash.tag"), registry.ROTATE_PASSKEY(), "ROTATE_PASSKEY");
        assertEq(json.readBytes32(".inboxKeyChangeHash.tag"), registry.SET_INBOX_KEY(), "SET_INBOX_KEY");
        _setPasskey(agent1, passkey);

        bytes32 x25519Pub = json.readBytes32(".inboxKeyChangeHash.x25519Pub");
        WebAuthn.WebAuthnAuth memory auth = _approve(passkey, agent1, json.readBytes32(".inboxKeyChangeHash.expected"));
        vm.prank(owner);
        registry.setInboxKey(agent1, x25519Pub, auth);
        assertEq(registry.inboxKeyOf(agent1), x25519Pub, "inbox key vector");

        bytes32 qx = json.readBytes32(".rotateChangeHash.qx");
        bytes32 qy = json.readBytes32(".rotateChangeHash.qy");
        auth = _approve(passkey, agent1, json.readBytes32(".rotateChangeHash.expected"));
        vm.prank(owner);
        registry.rotatePasskey(agent1, qx, qy, auth);
        (bytes32 storedQx, bytes32 storedQy) = registry.passkeyOf(agent1);
        assertEq(storedQx, qx, "rotate vector");
        assertEq(storedQy, qy, "rotate vector");
    }

    /// The e2e mandate: allowedTargets = [owner, demoPassThrough].
    function _checkE2eMandateVector(string memory json) internal view {
        address[] memory targets = new address[](2);
        targets[0] = json.readAddress(".e2eMandate.owner");
        targets[1] = json.readAddress(".e2eMandate.demoPassThrough");
        bytes[] memory selectorBytes = json.readBytesArray(".e2eMandate.allowedSelectors");
        bytes4[] memory selectors = new bytes4[](selectorBytes.length);
        for (uint256 i; i < selectorBytes.length; ++i) {
            assertEq(selectorBytes[i].length, 4, "selector length");
            selectors[i] = bytes4(selectorBytes[i]);
        }
        MandateRegistry.Mandate memory e2e = MandateRegistry.Mandate({
            allowedTargets: targets,
            allowedSelectors: selectors,
            maxValuePerTx: json.readUint(".e2eMandate.maxValuePerTx"),
            maxValuePerDay: json.readUint(".e2eMandate.maxValuePerDay"),
            validUntil: uint64(json.readUint(".e2eMandate.validUntil"))
        });
        assertEq(registry.mandateHashOf(e2e), json.readBytes32(".e2eMandate.mandateHash"), "e2e mandateHash");
    }

    /// Function and error selectors, and event topics.
    function _checkSelectorsAndTopics(string memory json) internal view {
        _checkSelector(json, "setPasskey", MandateRegistry.setPasskey.selector);
        _checkSelector(json, "rotatePasskey", MandateRegistry.rotatePasskey.selector);
        _checkSelector(json, "setMandate", MandateRegistry.setMandate.selector);
        _checkSelector(json, "revokeMandate", MandateRegistry.revokeMandate.selector);
        _checkSelector(json, "setInboxKey", MandateRegistry.setInboxKey.selector);
        _checkSelector(json, "getMandate", MandateRegistry.getMandate.selector);
        _checkSelector(json, "mandateHashOf", MandateRegistry.mandateHashOf.selector);
        _checkSelector(json, "passkeyOf", MandateRegistry.passkeyOf.selector);
        _checkSelector(json, "nonceOf", MandateRegistry.nonceOf.selector);
        _checkSelector(json, "inboxKeyOf", MandateRegistry.inboxKeyOf.selector);
        _checkSelector(json, "challengeFor", MandateRegistry.challengeFor.selector);
        _checkSelector(json, "rpIdHash", registry.rpIdHash.selector);
        _checkSelector(json, "NotAgentOwner", MandateRegistry.NotAgentOwner.selector);
        _checkSelector(json, "NoPasskey", MandateRegistry.NoPasskey.selector);
        _checkSelector(json, "PasskeyAlreadySet", MandateRegistry.PasskeyAlreadySet.selector);
        _checkSelector(json, "InvalidPasskey", MandateRegistry.InvalidPasskey.selector);
        _checkSelector(json, "WrongRpIdHash", MandateRegistry.WrongRpIdHash.selector);
        _checkSelector(json, "InvalidAssertion", MandateRegistry.InvalidAssertion.selector);
        _checkSelector(json, "ZeroInboxKey", MandateRegistry.ZeroInboxKey.selector);
        _checkSelector(json, "ZeroRpIdHash", MandateRegistry.ZeroRpIdHash.selector);
        _checkSelector(json, "ZeroIdentityRegistry", MandateRegistry.ZeroIdentityRegistry.selector);
        _checkSelector(json, "NoMandate", MandateRegistry.NoMandate.selector);
        _checkSelector(json, "MandateAlreadyExpired", MandateRegistry.MandateAlreadyExpired.selector);
        _checkSelector(json, "TooManyTargets", MandateRegistry.TooManyTargets.selector);
        _checkSelector(json, "TooManySelectors", MandateRegistry.TooManySelectors.selector);
        _checkSelector(json, "ZeroTarget", MandateRegistry.ZeroTarget.selector);
        _checkSelector(json, "TxCapAboveDailyCap", MandateRegistry.TxCapAboveDailyCap.selector);
        _checkTopic(json, "MandateSet", MandateRegistry.MandateSet.selector);
        _checkTopic(json, "MandateRevoked", MandateRegistry.MandateRevoked.selector);
        _checkTopic(json, "PasskeySet", MandateRegistry.PasskeySet.selector);
        _checkTopic(json, "PasskeyRotated", MandateRegistry.PasskeyRotated.selector);
        _checkTopic(json, "InboxKeySet", MandateRegistry.InboxKeySet.selector);
    }

    function _checkSelector(string memory json, string memory name, bytes4 selector) internal pure {
        assertEq(bytes4(json.readBytes(string.concat(".selectors.", name, ".selector"))), selector, name);
    }

    function _checkTopic(string memory json, string memory name, bytes32 topic) internal pure {
        assertEq(json.readBytes32(string.concat(".topics.", name, ".topic0")), topic, name);
    }

    function _at(string memory array, uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(array, "[", vm.toString(i), "]", field);
    }

    // ----------------------------------------------------------- gas

    /// A measurement, not a check: each call's frame gas (`vm.lastFrameGas`), with cold storage,
    /// against the mock Identity Registry. It leaves out the 21,000 intrinsic gas, calldata and the
    /// canonical Identity Registry's proxy `ownerOf`, so don't size live gas limits from it: the
    /// scripts' caps are fork-measured against the canonical registry (scripts/src/approval-plan.ts).
    /// forge-config: default.isolate = true
    function test_Gas_Record() public {
        MandateRegistry.Mandate memory mandate = _validMandate();
        bytes32 hash = registry.mandateHashOf(mandate);

        vm.prank(owner);
        registry.setPasskey(agent1, passkey.qx, passkey.qy);
        _logGas("setPasskey");

        WebAuthn.WebAuthnAuth memory auth = _approve(passkey, agent1, hash);
        vm.prank(owner);
        registry.setMandate(agent1, mandate, auth);
        _logGas("setMandate (first, 2 targets, 2 selectors)");

        auth = _approve(passkey, agent1, hash);
        vm.prank(owner);
        registry.setMandate(agent1, mandate, auth);
        _logGas("setMandate (same mandate again)");

        bytes32 x25519Pub = keccak256("x25519 public key");
        auth = _approve(passkey, agent1, _inboxHash(x25519Pub));
        vm.prank(owner);
        registry.setInboxKey(agent1, x25519Pub, auth);
        _logGas("setInboxKey");

        Signer memory next = _signer("nextPasskey");
        auth = _approve(passkey, agent1, _rotateHash(next.qx, next.qy));
        vm.prank(owner);
        registry.rotatePasskey(agent1, next.qx, next.qy, auth);
        _logGas("rotatePasskey");

        assertEq(registry.nonceOf(agent1), 4, "every call landed");
    }

    function _logGas(string memory label) internal view {
        Vm.Gas memory gas = vm.lastFrameGas();
        console.log(label, gas.gasTotalUsed);
    }
}
