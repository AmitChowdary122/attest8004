// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {ValidationRegistry} from "../src/ValidationRegistry.sol";

/// @notice Deploys ValidationRegistry through the canonical CREATE2 factory (Arachnid's
/// deterministic deployment proxy). Deploying with a CALL instead of `new` lets the transaction
/// carry a literal gas limit, which matters because Monad charges for the gas limit, not the gas
/// used. Re-running is a no-op once the contract exists.
/// The address depends on the init code, which includes the Identity Registry argument, so each
/// chain's registry has its own address. Run it with script/deploy-testnet.sh.
contract DeployValidationRegistry is Script {
    // CREATE2_FACTORY (0x4e59b448…956C) is inherited from forge-std's CommonBase.
    bytes32 public constant SALT = keccak256("attest8004.ValidationRegistry.v1");
    /// Literal gas limit for the deploy transaction. Monad testnet eth_estimateGas for this
    /// call on 2 Oct 2026 was 949,673; the limit is that x 1.2, rounded up to 10k.
    uint256 public constant DEPLOY_GAS = 1_140_000;

    address internal constant IDENTITY_TESTNET = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant IDENTITY_MAINNET = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;

    error UnsupportedChain(uint256 chainId);
    error DeployFailed(address predicted);

    function run() external returns (ValidationRegistry registry) {
        address identityRegistry = identityRegistryFor(block.chainid);

        vm.startBroadcast();
        registry = deploy(identityRegistry);
        vm.stopBroadcast();

        require(registry.getIdentityRegistry() == identityRegistry, "identity registry mismatch");
        console2.log("chainId           ", block.chainid);
        console2.log("IdentityRegistry  ", identityRegistry);
        console2.log("ValidationRegistry", address(registry));
    }

    /// @notice Deploys at `predictedAddress(identityRegistry)`, or returns the existing contract.
    function deploy(address identityRegistry) public returns (ValidationRegistry) {
        address predicted = predictedAddress(identityRegistry);
        if (predicted.code.length == 0) {
            (bool ok, bytes memory ret) =
                CREATE2_FACTORY.call{gas: DEPLOY_GAS}(abi.encodePacked(SALT, initCode(identityRegistry)));
            if (!ok || ret.length != 20 || address(bytes20(ret)) != predicted) revert DeployFailed(predicted);
        }
        return ValidationRegistry(predicted);
    }

    function predictedAddress(address identityRegistry) public pure returns (address) {
        bytes32 digest =
            keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, SALT, keccak256(initCode(identityRegistry))));
        return address(uint160(uint256(digest)));
    }

    function initCode(address identityRegistry) public pure returns (bytes memory) {
        return abi.encodePacked(type(ValidationRegistry).creationCode, abi.encode(identityRegistry));
    }

    function identityRegistryFor(uint256 chainId) public pure returns (address) {
        if (chainId == 10143) return IDENTITY_TESTNET;
        if (chainId == 143) return IDENTITY_MAINNET;
        revert UnsupportedChain(chainId);
    }
}
