// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";

/// @notice Scaffold smoke test (P0). Proves the toolchain later phases rely on:
/// the Monad network profile exposes P256VERIFY at 0x0100 with the documented
/// return semantics, and the OpenZeppelin remapping resolves.
contract ToolchainTest is Test {
    address internal constant P256_PRECOMPILE = address(0x0100);
    uint256 internal constant SIGNER = 0xA11CE;
    bytes32 internal constant DIGEST = keccak256("attest8004.toolchain");

    function _sign() internal pure returns (bytes32 r, bytes32 s, bytes32 qx, bytes32 qy) {
        (r, s) = vm.signP256(SIGNER, DIGEST);
        // Normalise to low-s; OpenZeppelin's P256.verify rejects s > N/2.
        if (uint256(s) > P256.N / 2) s = bytes32(P256.N - uint256(s));
        (uint256 x, uint256 y) = vm.publicKeyP256(SIGNER);
        (qx, qy) = (bytes32(x), bytes32(y));
    }

    function test_PrecompileReturnsOneForValidSignature() public view {
        (bytes32 r, bytes32 s, bytes32 qx, bytes32 qy) = _sign();
        (bool ok, bytes memory ret) = P256_PRECOMPILE.staticcall(abi.encodePacked(DIGEST, r, s, qx, qy));
        assertTrue(ok);
        assertEq(ret.length, 32);
        assertEq(abi.decode(ret, (uint256)), 1);
    }

    function test_PrecompileReturnsEmptyForInvalidSignature() public view {
        (bytes32 r, bytes32 s, bytes32 qx, bytes32 qy) = _sign();
        bytes32 wrongDigest = keccak256("attest8004.other");
        (bool ok, bytes memory ret) = P256_PRECOMPILE.staticcall(abi.encodePacked(wrongDigest, r, s, qx, qy));
        assertTrue(ok);
        assertEq(ret.length, 0);
    }

    function test_OpenZeppelinP256Verifies() public view {
        (bytes32 r, bytes32 s, bytes32 qx, bytes32 qy) = _sign();
        assertTrue(P256.verify(DIGEST, r, s, qx, qy));
        assertFalse(P256.verify(keccak256("attest8004.other"), r, s, qx, qy));
    }
}
