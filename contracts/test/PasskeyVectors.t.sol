// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

/// @notice Approval documents (`attest8004.approval.v1`, ARCHITECTURE §6) replayed through MandateRegistry v2:
/// the SDK-built vector (packages/sdk/test/webauthn-vector.json), which checks the TypeScript WebAuthn parsing against
/// the Solidity verification. Each document is replayed at its own registry address and chain id, with the agent's
/// owner mocked and its passkey set from the document, so the challenge the contract computes is the one that was
/// signed.
contract PasskeyVectorsTest is Test {
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    bytes32 internal constant RP_ID_HASH = sha256("attest8004.vercel.app");
    string internal constant SDK_VECTOR = "../packages/sdk/test/webauthn-vector.json";

    address internal identity = makeAddr("identity registry");
    address internal owner = makeAddr("agent owner");

    function test_SdkBuiltVector_PassesTheContract() public {
        string[] memory files = new string[](1);
        files[0] = SDK_VECTOR;
        _replay(files, identity);
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
