// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {DemoPassThrough} from "../src/DemoPassThrough.sol";

/// @notice Deploys the demo DemoPassThrough through the canonical CREATE2 factory, with a literal
/// gas limit (Monad charges for the gas limit, not the gas used). Re-running is a no-op once the
/// contract exists. Run it with `script/deploy-testnet.sh DemoPassThrough`, which first checks
/// Monad's eth_estimateGas for this call against DEPLOY_GAS (see deployPlan).
/// DemoPassThrough is the P5 risky-but-mandated demo target (SPEC §4.6, decision 34): a fresh
/// "payment router" that forwards every payment straight to `SINK`, an address nobody controls.
/// The operator allowlists it next to the deployer in demo agent 1984's mandate (approved on
/// /approve, submitted with submit-approval);
/// mandate-v1 approves a plain transfer to it, and risk-v1's simulation sees the value keep
/// moving on to `SINK`.
contract DeployDemoPassThrough is Script {
    // CREATE2_FACTORY (0x4e59b448…956C) is inherited from forge-std's CommonBase.
    bytes32 public constant SALT = keccak256("attest8004.DemoPassThrough.v1");
    /// Nobody holds this address's key: `address(uint160(uint256(keccak256(
    /// "attest8004.demo.sink"))))`, the same value TypeScript gets as
    /// `getAddress(slice(keccak256(toBytes("attest8004.demo.sink")), 12))`.
    address payable public constant SINK = payable(address(uint160(uint256(keccak256("attest8004.demo.sink")))));
    /// Literal gas limit for the deploy transaction. Monad testnet eth_estimateGas for this call
    /// on 4 Oct 2026 was 141,975; the limit is that x 1.2, rounded up to 10k.
    uint256 public constant DEPLOY_GAS = 180_000;

    error UnsupportedChain(uint256 chainId);
    error DeployFailed(address predicted);

    function run() external returns (DemoPassThrough passThrough) {
        address payable sink = configFor(block.chainid);

        vm.startBroadcast();
        passThrough = deploy(sink);
        vm.stopBroadcast();

        require(passThrough.sink() == sink, "sink mismatch");
        console2.log("chainId        ", block.chainid);
        console2.log("sink           ", sink);
        console2.log("DemoPassThrough", address(passThrough));
    }

    /// @notice Deploys at `predictedAddress(sink)`, or returns the existing contract.
    function deploy(address payable sink) public returns (DemoPassThrough) {
        address predicted = predictedAddress(sink);
        if (predicted.code.length == 0) {
            (bool ok, bytes memory ret) = CREATE2_FACTORY.call{gas: DEPLOY_GAS}(_deployCalldata(sink));
            if (!ok || ret.length != 20 || address(bytes20(ret)) != predicted) revert DeployFailed(predicted);
        }
        return DemoPassThrough(payable(predicted));
    }

    /// @notice The exact transaction deploy() broadcasts on `chainId`, so the wrapper can compare
    /// the node's gas estimate with the limit before sending.
    function deployPlan(uint256 chainId)
        public
        pure
        returns (address to, bytes memory data, uint256 gasLimit, address predicted)
    {
        address payable sink = configFor(chainId);
        return (CREATE2_FACTORY, _deployCalldata(sink), DEPLOY_GAS, predictedAddress(sink));
    }

    /// @notice The demo pass-through's configuration: `SINK`, the only sink this script knows.
    /// Only testnet has a ValidationRegistry so far, so only there can a mandate allowlist it.
    function configFor(uint256 chainId) public pure returns (address payable sink) {
        if (chainId != 10143) revert UnsupportedChain(chainId);
        return SINK;
    }

    function predictedAddress(address payable sink) public pure returns (address) {
        bytes32 digest = keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, SALT, keccak256(initCode(sink))));
        return address(uint160(uint256(digest)));
    }

    function initCode(address payable sink) public pure returns (bytes memory) {
        return abi.encodePacked(type(DemoPassThrough).creationCode, abi.encode(sink));
    }

    function _deployCalldata(address payable sink) internal pure returns (bytes memory) {
        return abi.encodePacked(SALT, initCode(sink));
    }
}
