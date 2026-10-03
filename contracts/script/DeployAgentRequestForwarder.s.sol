// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {AgentRequestForwarder} from "../src/AgentRequestForwarder.sol";

/// @notice Deploys AgentRequestForwarder through the canonical CREATE2 factory, with a literal gas
/// limit (Monad charges for the gas limit, not the gas used). Re-running is a no-op once the
/// contract exists. Run it with `script/deploy-testnet.sh AgentRequestForwarder`, which first checks
/// Monad's eth_estimateGas for this call against DEPLOY_GAS (see deployPlan).
/// The only constructor argument is the ValidationRegistry; the forwarder reads the Identity
/// Registry from it. The address depends on the registry, so another registry gets another address.
contract DeployAgentRequestForwarder is Script {
    // CREATE2_FACTORY (0x4e59b448…956C) is inherited from forge-std's CommonBase.
    bytes32 public constant SALT = keccak256("attest8004.AgentRequestForwarder.v1");
    /// Literal gas limit for the deploy transaction. Monad testnet eth_estimateGas for this
    /// call on 3 Oct 2026 was 407,868; the limit is that x 1.2, rounded up to 10k.
    uint256 public constant DEPLOY_GAS = 490_000;

    address public constant VALIDATION_REGISTRY_TESTNET = 0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f;

    error UnsupportedChain(uint256 chainId);
    error DeployFailed(address predicted);

    function run() external returns (AgentRequestForwarder forwarder) {
        address registry = configFor(block.chainid);

        vm.startBroadcast();
        forwarder = deploy(registry);
        vm.stopBroadcast();

        require(address(forwarder.validationRegistry()) == registry, "validation registry mismatch");
        console2.log("chainId              ", block.chainid);
        console2.log("ValidationRegistry   ", registry);
        console2.log("IdentityRegistry     ", address(forwarder.identityRegistry()));
        console2.log("AgentRequestForwarder", address(forwarder));
    }

    /// @notice Deploys at `predictedAddress(registry)`, or returns the existing contract.
    function deploy(address registry) public returns (AgentRequestForwarder) {
        address predicted = predictedAddress(registry);
        if (predicted.code.length == 0) {
            (bool ok, bytes memory ret) = CREATE2_FACTORY.call{gas: DEPLOY_GAS}(_deployCalldata(registry));
            if (!ok || ret.length != 20 || address(bytes20(ret)) != predicted) revert DeployFailed(predicted);
        }
        return AgentRequestForwarder(predicted);
    }

    /// @notice The exact transaction deploy() broadcasts on `chainId`, so the wrapper can compare
    /// the node's gas estimate with the limit before sending.
    function deployPlan(uint256 chainId)
        public
        pure
        returns (address to, bytes memory data, uint256 gasLimit, address predicted)
    {
        address registry = configFor(chainId);
        return (CREATE2_FACTORY, _deployCalldata(registry), DEPLOY_GAS, predictedAddress(registry));
    }

    /// @notice The ValidationRegistry the forwarder serves. Only testnet has one so far.
    function configFor(uint256 chainId) public pure returns (address registry) {
        if (chainId != 10143) revert UnsupportedChain(chainId);
        return VALIDATION_REGISTRY_TESTNET;
    }

    function predictedAddress(address registry) public pure returns (address) {
        bytes32 digest = keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, SALT, keccak256(initCode(registry))));
        return address(uint160(uint256(digest)));
    }

    function initCode(address registry) public pure returns (bytes memory) {
        return abi.encodePacked(type(AgentRequestForwarder).creationCode, abi.encode(registry));
    }

    function _deployCalldata(address registry) internal pure returns (bytes memory) {
        return abi.encodePacked(SALT, initCode(registry));
    }
}
