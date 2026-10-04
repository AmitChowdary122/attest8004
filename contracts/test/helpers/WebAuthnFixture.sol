// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @notice Real WebAuthn assertions for the MandateRegistry tests. Keys and signatures come from
/// forge's `vm.signP256`; `authenticatorData` and `clientDataJSON` are shaped like Chrome's for a
/// synced Google Password Manager passkey on `attest8004.vercel.app`. `typeIndex` and
/// `challengeIndex` are found in the JSON, never hard-coded, so a reordered or extended JSON still
/// gets the right indices.
abstract contract WebAuthnFixture is Test {
    struct Signer {
        uint256 pk;
        bytes32 qx;
        bytes32 qy;
    }

    /// What `_assertWith` may vary: the authenticator flags, the rpIdHash in `authenticatorData`,
    /// whether `s` is left in the high half (which `P256.verify` rejects), and whether Chrome's
    /// extra `other_keys_can_be_added_here` key is appended to `clientDataJSON`.
    struct AssertOpts {
        bytes1 flags;
        bytes32 rpIdHash;
        bool highS;
        bool extraKey;
    }

    string internal constant RP_ID = "attest8004.vercel.app";
    string internal constant ORIGIN = "https://attest8004.vercel.app";
    bytes32 internal constant RP_ID_HASH = sha256(bytes(RP_ID));
    /// UP | UV | BE | BS: a user-verified assertion from a synced (backed-up) passkey.
    bytes1 internal constant FLAGS_SYNCED_UV = 0x1D;
    /// The key Chrome sometimes inserts so that relying parties don't compare against a template.
    string internal constant CHROME_EXTRA_KEY =
        ',"other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See https://goo.gl/yabPex"';

    function _signer(string memory label) internal pure returns (Signer memory signer) {
        signer.pk = uint256(keccak256(bytes(label))) % (P256.N - 1) + 1;
        (uint256 x, uint256 y) = vm.publicKeyP256(signer.pk);
        (signer.qx, signer.qy) = (bytes32(x), bytes32(y));
    }

    /// A valid assertion over `challenge`: flags 0x1D, our rpIdHash, low-s, Chrome's usual JSON.
    function _assert(Signer memory signer, bytes32 challenge) internal pure returns (WebAuthn.WebAuthnAuth memory) {
        return _assertWith(
            signer, challenge, AssertOpts({flags: FLAGS_SYNCED_UV, rpIdHash: RP_ID_HASH, highS: false, extraKey: false})
        );
    }

    function _assertWith(Signer memory signer, bytes32 challenge, AssertOpts memory opts)
        internal
        pure
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"',
            ORIGIN,
            '","crossOrigin":false',
            opts.extraKey ? CHROME_EXTRA_KEY : "",
            "}"
        );
        // rpIdHash (32) ‖ flags (1) ‖ signCount (4; synced passkeys report 0).
        bytes memory authenticatorData = abi.encodePacked(opts.rpIdHash, opts.flags, bytes4(0));
        (bytes32 r, bytes32 s) = vm.signP256(signer.pk, _digest(authenticatorData, clientDataJSON));
        if ((uint256(s) > P256.N / 2) != opts.highS) s = bytes32(P256.N - uint256(s));

        auth = WebAuthn.WebAuthnAuth({
            r: r,
            s: s,
            challengeIndex: _indexOf(bytes(clientDataJSON), bytes('"challenge":"')),
            typeIndex: _indexOf(bytes(clientDataJSON), bytes('"type":"')),
            authenticatorData: authenticatorData,
            clientDataJSON: clientDataJSON
        });
    }

    /// The message a WebAuthn authenticator signs: sha256(authenticatorData ‖ sha256(clientDataJSON)).
    function _digest(bytes memory authenticatorData, string memory clientDataJSON) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
    }

    function _indexOf(bytes memory haystack, bytes memory needle) internal pure returns (uint256) {
        for (uint256 i; i + needle.length <= haystack.length; ++i) {
            bool found = true;
            for (uint256 j; j < needle.length; ++j) {
                if (haystack[i + j] != needle[j]) {
                    found = false;
                    break;
                }
            }
            if (found) return i;
        }
        revert("WebAuthnFixture: needle not found");
    }
}
