// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

/// @notice Approval documents (`attest8004.approval.v1`, ARCHITECTURE §6) replayed through MandateRegistry v2:
/// the SDK-built vector (packages/sdk/test/webauthn-vector.json), which checks the TypeScript WebAuthn parsing against
/// the Solidity verification, and the real assertions recorded in the P6 live run (test/vectors/: laptop Chrome and
/// Chrome on Android, one synced Google Password Manager passkey). Each document is replayed at its own registry address and chain id, with the agent's
/// owner mocked and its passkey set from the document, so the challenge the contract computes is the one that was
/// signed.
contract PasskeyVectorsTest is Test {
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    bytes32 internal constant RP_ID_HASH = sha256("attest8004.vercel.app");
    string internal constant SDK_VECTOR = "../packages/sdk/test/webauthn-vector.json";
    /// The SDK-built setInboxKey approval (P7), signed by the same test key at nonce 1, after SDK_VECTOR.
    string internal constant SDK_INBOX_VECTOR = "../packages/sdk/test/webauthn-inbox-vector.json";

    address internal identity = makeAddr("identity registry");
    address internal owner = makeAddr("agent owner");

    function test_SdkBuiltVector_PassesTheContract() public {
        string[] memory files = new string[](1);
        files[0] = SDK_VECTOR;
        _replay(files, identity);
    }

    /// The TS-built inbox approval sets the inbox key through the contract: the change hash and challenge the SDK
    /// computed are the contract's, and the assertion verifies (nonce 1 → 2).
    function test_SdkInboxVector_SetsInboxKeyThroughTheContract() public {
        string[] memory files = new string[](1);
        files[0] = SDK_VECTOR;
        MandateRegistry registry = _replay(files, identity);

        string memory json = vm.readFile(SDK_INBOX_VECTOR);
        uint256 agentId = vm.parseJsonUint(json, ".agentId");
        assertEq(vm.parseJsonString(json, ".change.kind"), "setInboxKey");
        assertEq(vm.parseJsonAddress(json, ".registry"), address(registry));
        assertEq(registry.nonceOf(agentId), vm.parseJsonUint(json, ".nonce"));
        bytes32 x25519Pub = vm.parseJsonBytes32(json, ".change.x25519Pub");
        bytes32 changeHash = keccak256(abi.encode(registry.SET_INBOX_KEY(), x25519Pub));
        assertEq(changeHash, vm.parseJsonBytes32(json, ".changeHash"), "changeHash");
        assertEq(
            registry.challengeFor(agentId, changeHash, registry.nonceOf(agentId)),
            vm.parseJsonBytes32(json, ".challenge"),
            "challenge"
        );

        vm.prank(owner);
        registry.setInboxKey(agentId, x25519Pub, _auth(json));

        assertEq(registry.inboxKeyOf(agentId), x25519Pub);
        assertEq(registry.nonceOf(agentId), 2);
    }

    function test_SdkBuiltVector_HighSFails() public {
        string memory json = vm.readFile(SDK_VECTOR);
        (MandateRegistry registry, uint256 agentId) = _setUp(json, identity);
        WebAuthn.WebAuthnAuth memory auth = _auth(json);
        auth.s = bytes32(P256_N - uint256(auth.s));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.InvalidAssertion.selector, agentId));
        registry.setMandate(agentId, _mandate(json), auth);
    }

    // ------------------------------------------------- real device vectors (P6 live run, 5 Oct 2026)

    /// The real Google Password Manager passkey: created on laptop Chrome (Linux), then used from laptop Chrome
    /// (nonce 0) and, synced, from Chrome on Android (nonce 1). Both approvals landed on the live v2 registry.
    address internal constant LIVE_IDENTITY_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    string internal constant REGISTRATION = "test/vectors/passkey-registration.json";
    string internal constant LAPTOP = "test/vectors/passkey-01-laptop-chrome.json";
    string internal constant ANDROID = "test/vectors/passkey-02-android-chrome.json";

    function _realDevices() internal pure returns (string[] memory files) {
        files = new string[](2);
        files[0] = LAPTOP;
        files[1] = ANDROID;
    }

    /// Each real assertion on its own: its challenge recomputes from its fields as the contract's `challengeFor`
    /// does, its authenticator data starts with the rpIdHash, and OpenZeppelin's `WebAuthn.verify` (UV required)
    /// accepts it against the registered key, which both devices share.
    function test_RealDeviceVectors_LibraryLevel() public view {
        string memory registration = vm.readFile(REGISTRATION);
        bytes32 qx = vm.parseJsonBytes32(registration, ".qx");
        bytes32 qy = vm.parseJsonBytes32(registration, ".qy");
        string[] memory files = _realDevices();
        for (uint256 i; i < files.length; ++i) {
            string memory json = vm.readFile(files[i]);
            assertEq(vm.parseJsonBytes32(json, ".passkey.qx"), qx, "the registered key");
            assertEq(vm.parseJsonBytes32(json, ".passkey.qy"), qy, "the registered key");
            assertEq(
                vm.parseJsonString(json, ".passkey.credentialId"),
                vm.parseJsonString(registration, ".credentialId"),
                "one credential"
            );

            bytes32 challenge = sha256(
                abi.encode(
                    vm.parseJsonUint(json, ".chainId"),
                    vm.parseJsonAddress(json, ".registry"),
                    vm.parseJsonUint(json, ".agentId"),
                    vm.parseJsonBytes32(json, ".changeHash"),
                    vm.parseJsonUint(json, ".nonce")
                )
            );
            assertEq(challenge, vm.parseJsonBytes32(json, ".challenge"), "challenge");

            WebAuthn.WebAuthnAuth memory auth = _auth(json);
            assertEq(bytes32(this.firstWord(auth.authenticatorData)), RP_ID_HASH, "rpIdHash");
            assertTrue(WebAuthn.verify(abi.encodePacked(challenge), auth, qx, qy, true), files[i]);
        }
    }

    /// Both approvals, in the order they landed, through the v2 code at the live registry's address with the live
    /// constructor arguments, on chain 10143: setPasskey, then each setMandate succeeds and the nonce ends at 2.
    function test_RealDeviceVectors_ReplayThroughTheContract() public {
        _replay(_realDevices(), LIVE_IDENTITY_REGISTRY);
    }

    /// The same signatures with `s` flipped to `n − s` (equally valid ECDSA) are rejected: OpenZeppelin's P256
    /// accepts low-s only, so neither real assertion has a second valid form.
    function test_RealDeviceVectors_HighSFails() public {
        string memory registration = vm.readFile(REGISTRATION);
        bytes32 qx = vm.parseJsonBytes32(registration, ".qx");
        bytes32 qy = vm.parseJsonBytes32(registration, ".qy");
        string[] memory files = _realDevices();
        for (uint256 i; i < files.length; ++i) {
            string memory json = vm.readFile(files[i]);
            WebAuthn.WebAuthnAuth memory auth = _auth(json);
            auth.s = bytes32(P256_N - uint256(auth.s));
            bytes memory challenge = abi.encodePacked(vm.parseJsonBytes32(json, ".challenge"));
            assertFalse(WebAuthn.verify(challenge, auth, qx, qy, true), files[i]);
        }

        string memory laptop = vm.readFile(LAPTOP);
        (MandateRegistry registry, uint256 agentId) = _setUp(laptop, LIVE_IDENTITY_REGISTRY);
        WebAuthn.WebAuthnAuth memory flipped = _auth(laptop);
        flipped.s = bytes32(P256_N - uint256(flipped.s));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.InvalidAssertion.selector, agentId));
        registry.setMandate(agentId, _mandate(laptop), flipped);
    }

    /// The first 32 bytes of `data` (an external call, so calldata slicing applies).
    function firstWord(bytes calldata data) external pure returns (bytes32) {
        return bytes32(data[0:32]);
    }

    /// @dev Replays `files`, in order, as one agent's successive approvals on one registry: the first document fixes
    /// the registry address, chain id, agent and passkey; each document's nonce must be the registry's nonce when it
    /// is submitted, and every `setMandate` must succeed. Task 7's real device vectors reuse this.
    function _replay(string[] memory files, address identityRegistry) internal returns (MandateRegistry registry) {
        string memory first = vm.readFile(files[0]);
        uint256 agentId;
        (registry, agentId) = _setUp(first, identityRegistry);
        for (uint256 i; i < files.length; ++i) {
            string memory json = vm.readFile(files[i]);
            assertEq(vm.parseJsonAddress(json, ".registry"), address(registry), "one registry per replay");
            assertEq(vm.parseJsonUint(json, ".agentId"), agentId, "one agent per replay");
            assertEq(registry.nonceOf(agentId), vm.parseJsonUint(json, ".nonce"), "nonce at submission");

            MandateRegistry.Mandate memory mandate = _mandate(json);
            assertEq(registry.mandateHashOf(mandate), vm.parseJsonBytes32(json, ".changeHash"), "changeHash");
            assertEq(
                registry.challengeFor(agentId, registry.mandateHashOf(mandate), registry.nonceOf(agentId)),
                vm.parseJsonBytes32(json, ".challenge"),
                "challenge"
            );

            vm.prank(owner);
            registry.setMandate(agentId, mandate, _auth(json));
            (, bytes32 storedHash,,) = registry.getMandate(agentId);
            assertEq(storedHash, registry.mandateHashOf(mandate));
        }
        assertEq(registry.nonceOf(agentId), files.length);
    }

    function _setUp(string memory json, address identityRegistry)
        internal
        returns (MandateRegistry registry, uint256 agentId)
    {
        address registryAddress = vm.parseJsonAddress(json, ".registry");
        vm.chainId(vm.parseJsonUint(json, ".chainId"));
        deployCodeTo("MandateRegistry.sol:MandateRegistry", abi.encode(identityRegistry, RP_ID_HASH), registryAddress);
        registry = MandateRegistry(registryAddress);
        agentId = vm.parseJsonUint(json, ".agentId");

        vm.etch(identityRegistry, hex"00");
        vm.mockCall(identityRegistry, abi.encodeCall(IIdentityRegistry.ownerOf, (agentId)), abi.encode(owner));
        vm.prank(owner);
        registry.setPasskey(agentId, vm.parseJsonBytes32(json, ".passkey.qx"), vm.parseJsonBytes32(json, ".passkey.qy"));
    }

    function _mandate(string memory json) internal pure returns (MandateRegistry.Mandate memory mandate) {
        bytes[] memory selectors = vm.parseJsonBytesArray(json, ".change.mandate.allowedSelectors");
        mandate.allowedSelectors = new bytes4[](selectors.length);
        for (uint256 i; i < selectors.length; ++i) {
            mandate.allowedSelectors[i] = bytes4(selectors[i]);
        }
        mandate.allowedTargets = vm.parseJsonAddressArray(json, ".change.mandate.allowedTargets");
        mandate.maxValuePerTx = vm.parseJsonUint(json, ".change.mandate.maxValuePerTx");
        mandate.maxValuePerDay = vm.parseJsonUint(json, ".change.mandate.maxValuePerDay");
        // forge-lint: disable-next-line(unsafe-typecast) -- the approval schema bounds validUntil to uint64
        mandate.validUntil = uint64(vm.parseJsonUint(json, ".change.mandate.validUntil"));
    }

    function _auth(string memory json) internal pure returns (WebAuthn.WebAuthnAuth memory auth) {
        auth.r = vm.parseJsonBytes32(json, ".auth.r");
        auth.s = vm.parseJsonBytes32(json, ".auth.s");
        auth.challengeIndex = vm.parseJsonUint(json, ".auth.challengeIndex");
        auth.typeIndex = vm.parseJsonUint(json, ".auth.typeIndex");
        auth.authenticatorData = vm.parseJsonBytes(json, ".auth.authenticatorData");
        auth.clientDataJSON = vm.parseJsonString(json, ".auth.clientDataJSON");
    }
}
