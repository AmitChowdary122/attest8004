// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";

/// @notice Deploys MandateRegistry through the canonical CREATE2 factory, with a literal gas limit
/// (Monad charges for the gas limit, not the gas used). Re-running is a no-op once the contract
/// exists. Run it with `script/deploy-testnet.sh MandateRegistry`, which first checks Monad's
/// eth_estimateGas for this call against DEPLOY_GAS (see deployPlan).
/// v2 (P6, passkey-approved changes). The constructor arguments are the Identity Registry and
/// `RP_ID_HASH`; the address depends on both, so another Identity Registry gets another address.
contract DeployMandateRegistry is Script {
    // CREATE2_FACTORY (0x4e59b448…956C) is inherited from forge-std's CommonBase.
    bytes32 public constant SALT = keccak256("attest8004.MandateRegistry.v2");
    /// Literal gas limit for the deploy transaction. Monad testnet eth_estimateGas for this exact
    /// call (deploy-testnet.sh's dry run) was 2,241,334 on 5 Oct 2026; the limit is that x 1.2,
    /// rounded up to 10k. (Forge's isolated measurement was 2,204,014.)
    uint256 public constant DEPLOY_GAS = 2_690_000;

    address public constant IDENTITY_REGISTRY_TESTNET = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    /// The WebAuthn relying party: the fixed web domain the passkeys are created on.
    string public constant RP_ID = "attest8004.vercel.app";
    bytes32 public constant RP_ID_HASH = sha256(bytes(RP_ID));

    error UnsupportedChain(uint256 chainId);
    error DeployFailed(address predicted);

    function run() external returns (MandateRegistry registry) {
        address identity = configFor(block.chainid);

        vm.startBroadcast();
        registry = deploy(identity);
        vm.stopBroadcast();

        require(address(registry.identityRegistry()) == identity, "identity registry mismatch");
        require(registry.rpIdHash() == RP_ID_HASH, "rpIdHash mismatch");
        console2.log("chainId          ", block.chainid);
        console2.log("IdentityRegistry ", identity);
        console2.log("rpId             ", RP_ID);
        console2.log("MandateRegistry  ", address(registry));
    }

    /// @notice Deploys at `predictedAddress(identity)`, or returns the existing contract.
    function deploy(address identity) public returns (MandateRegistry) {
        address predicted = predictedAddress(identity);
        if (predicted.code.length == 0) {
            (bool ok, bytes memory ret) = CREATE2_FACTORY.call{gas: DEPLOY_GAS}(_deployCalldata(identity));
            if (!ok || ret.length != 20 || address(bytes20(ret)) != predicted) revert DeployFailed(predicted);
        }
        return MandateRegistry(predicted);
    }

    /// @notice The exact transaction deploy() broadcasts on `chainId`, so the wrapper can compare
    /// the node's gas estimate with the limit before sending.
    function deployPlan(uint256 chainId)
        public
        pure
        returns (address to, bytes memory data, uint256 gasLimit, address predicted)
    {
        address identity = configFor(chainId);
        return (CREATE2_FACTORY, _deployCalldata(identity), DEPLOY_GAS, predictedAddress(identity));
    }

    /// @notice The Identity Registry this MandateRegistry reads from. Only testnet so far.
    function configFor(uint256 chainId) public pure returns (address identity) {
        if (chainId != 10143) revert UnsupportedChain(chainId);
        return IDENTITY_REGISTRY_TESTNET;
    }

    function predictedAddress(address identity) public pure returns (address) {
        bytes32 digest = keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, SALT, keccak256(initCode(identity))));
        return address(uint160(uint256(digest)));
    }

    function initCode(address identity) public pure returns (bytes memory) {
        return abi.encodePacked(type(MandateRegistry).creationCode, abi.encode(identity, RP_ID_HASH));
    }

    function _deployCalldata(address identity) internal pure returns (bytes memory) {
        return abi.encodePacked(SALT, initCode(identity));
    }
}
