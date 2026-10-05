// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {CreValidator} from "../src/CreValidator.sol";

/// @notice Deploys CreValidator (validator C, P11) through the canonical CREATE2 factory, with a
/// literal gas limit (Monad charges for the gas limit, not the gas used). Re-running is a no-op
/// once the contract exists. Run it with `script/deploy-testnet.sh CreValidator`, which first checks
/// Monad's eth_estimateGas for this call against DEPLOY_GAS (see deployPlan).
/// @dev Testnet C trusts the CRE **MockKeystoneForwarder** (CRE's Forwarder Directory), so it is a
/// simulation-only validator and never a trust root (docs/cre.md). The production KeystoneForwarder
/// on Monad testnet is 0xF8344CFd5c43616a4366C34E3EEE75af79a74482; a production C would be a new
/// deployment with it and the real workflow owner (ARCHITECTURE §12).
contract DeployCreValidator is Script {
    // CREATE2_FACTORY (0x4e59b448…956C) is inherited from forge-std's CommonBase.
    bytes32 public constant SALT = keccak256("attest8004.CreValidator.v1");
    /// CRE's MockKeystoneForwarder on Monad testnet ("MockKeystoneForwarder 1.0.0").
    address public constant MOCK_FORWARDER = 0xB9F79d863261869B234c481D1f9A7af84AeAd192;
    /// Attest8004's ValidationRegistry on Monad testnet (docs/deployments.md).
    address public constant REGISTRY = 0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f;
    /// The workflow owner the CRE simulator writes into every report's metadata (a placeholder).
    address public constant SIM_WORKFLOW_OWNER = 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa;
    /// "68ce083cf5": the first 10 hex characters of sha256("attest8004-validator-c"), the
    /// workflow-name in cre/validator-c/workflow.yaml.
    bytes10 public constant WORKFLOW_NAME = 0x36386365303833636635;
    /// Literal gas limit for the deploy transaction, set from Monad's eth_estimateGas (Task 3).
    uint256 public constant DEPLOY_GAS = 600_000;

    error UnsupportedChain(uint256 chainId);
    error DeployFailed(address predicted);

    function run() external returns (CreValidator c) {
        if (block.chainid != 10143) revert UnsupportedChain(block.chainid);

        vm.startBroadcast();
        c = deploy();
        vm.stopBroadcast();

        require(c.forwarder() == MOCK_FORWARDER, "unexpected forwarder");
        console2.log("chainId     ", block.chainid);
        console2.log("CreValidator", address(c));
    }

    /// @notice Deploys at `predictedAddress()`, or returns the existing contract.
    function deploy() public returns (CreValidator) {
        address predicted = predictedAddress();
        if (predicted.code.length == 0) {
            (bool ok, bytes memory ret) = CREATE2_FACTORY.call{gas: DEPLOY_GAS}(_deployCalldata());
            if (!ok || ret.length != 20 || address(bytes20(ret)) != predicted) revert DeployFailed(predicted);
        }
        return CreValidator(predicted);
    }

    /// @notice The exact transaction deploy() broadcasts on `chainId`, so the wrapper can compare
    /// the node's gas estimate with the limit before sending. Only testnet is supported.
    function deployPlan(uint256 chainId)
        public
        pure
        returns (address to, bytes memory data, uint256 gasLimit, address predicted)
    {
        if (chainId != 10143) revert UnsupportedChain(chainId);
        return (CREATE2_FACTORY, _deployCalldata(), DEPLOY_GAS, predictedAddress());
    }

    function predictedAddress() public pure returns (address) {
        bytes32 digest = keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, SALT, keccak256(initCode())));
        return address(uint160(uint256(digest)));
    }

    function initCode() public pure returns (bytes memory) {
        return abi.encodePacked(
            type(CreValidator).creationCode, abi.encode(MOCK_FORWARDER, REGISTRY, SIM_WORKFLOW_OWNER, WORKFLOW_NAME)
        );
    }

    function _deployCalldata() internal pure returns (bytes memory) {
        return abi.encodePacked(SALT, initCode());
    }
}
