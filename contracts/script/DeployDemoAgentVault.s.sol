// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {AttestGate} from "../src/AttestGate.sol";
import {DemoAgentVault} from "../src/DemoAgentVault.sol";

/// @notice Deploys the demo DemoAgentVault through the canonical CREATE2 factory, with a literal
/// gas limit (Monad charges for the gas limit, not the gas used). Re-running is a no-op once the
/// contract exists. Run it with `script/deploy-testnet.sh DemoAgentVault`, which first checks
/// Monad's eth_estimateGas for this call against DEPLOY_GAS (see deployPlan).
/// The configuration is constants, so the deployed vault's settings are reviewable in git:
/// demo agent 1984 (registered in P3; its hot key requests through the AgentRequestForwarder),
/// validator A (mandate-v1) with a minimum score of 100, and validator B (risk-v1) with a minimum
/// score of 80. The P2 vault for test agent 1982, and the P3 vault requiring validator A only, are
/// superseded; the new constructor arguments give this vault a new address.
contract DeployDemoAgentVault is Script {
    // CREATE2_FACTORY (0x4e59b448…956C) is inherited from forge-std's CommonBase.
    bytes32 public constant SALT = keccak256("attest8004.DemoAgentVault.v1");
    /// Literal gas limit for the deploy transaction. Monad testnet eth_estimateGas for this
    /// call on 4 Oct 2026 was 903,163; the limit is that x 1.2, rounded up to 10k.
    uint256 public constant DEPLOY_GAS = 1_090_000;

    address public constant VALIDATION_REGISTRY_TESTNET = 0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f;
    uint256 public constant AGENT_ID_TESTNET = 1984;
    address public constant VALIDATOR_A = 0xa62DaB21E0C0F57e94B3ed6e675F214199989e92;
    uint8 public constant MIN_SCORE_A = 100;
    bytes32 public constant TAG_A = keccak256("mandate-v1");
    address public constant VALIDATOR_B = 0x780df855b48AeC7A3907433b0b5984A2fe5dca5E;
    uint8 public constant MIN_SCORE_B = 80;
    bytes32 public constant TAG_B = keccak256("risk-v1");

    error UnsupportedChain(uint256 chainId);
    error DeployFailed(address predicted);

    function run() external returns (DemoAgentVault vault) {
        (address registry, uint256 agentId, AttestGate.Requirement[] memory requirements) = configFor(block.chainid);

        vm.startBroadcast();
        vault = deploy(registry, agentId, requirements);
        vm.stopBroadcast();

        require(address(vault.validationRegistry()) == registry, "validation registry mismatch");
        require(vault.agentId() == agentId, "agentId mismatch");
        console2.log("chainId           ", block.chainid);
        console2.log("ValidationRegistry", registry);
        console2.log("agentId           ", agentId);
        console2.log("DemoAgentVault    ", address(vault));
    }

    /// @notice Deploys at `predictedAddress(...)`, or returns the existing contract.
    function deploy(address registry, uint256 agentId, AttestGate.Requirement[] memory requirements)
        public
        returns (DemoAgentVault)
    {
        address predicted = predictedAddress(registry, agentId, requirements);
        if (predicted.code.length == 0) {
            (bool ok, bytes memory ret) =
                CREATE2_FACTORY.call{gas: DEPLOY_GAS}(_deployCalldata(registry, agentId, requirements));
            if (!ok || ret.length != 20 || address(bytes20(ret)) != predicted) revert DeployFailed(predicted);
        }
        return DemoAgentVault(payable(predicted));
    }

    /// @notice The exact transaction deploy() broadcasts on `chainId`, so the wrapper can compare
    /// the node's gas estimate with the limit before sending.
    function deployPlan(uint256 chainId)
        public
        pure
        returns (address to, bytes memory data, uint256 gasLimit, address predicted)
    {
        (address registry, uint256 agentId, AttestGate.Requirement[] memory requirements) = configFor(chainId);
        return (
            CREATE2_FACTORY,
            _deployCalldata(registry, agentId, requirements),
            DEPLOY_GAS,
            predictedAddress(registry, agentId, requirements)
        );
    }

    /// @notice The demo vault's configuration. Only testnet has a ValidationRegistry so far.
    function configFor(uint256 chainId)
        public
        pure
        returns (address registry, uint256 agentId, AttestGate.Requirement[] memory requirements)
    {
        if (chainId != 10143) revert UnsupportedChain(chainId);
        requirements = new AttestGate.Requirement[](2);
        requirements[0] = AttestGate.Requirement(VALIDATOR_A, MIN_SCORE_A, TAG_A);
        requirements[1] = AttestGate.Requirement(VALIDATOR_B, MIN_SCORE_B, TAG_B);
        return (VALIDATION_REGISTRY_TESTNET, AGENT_ID_TESTNET, requirements);
    }

    function predictedAddress(address registry, uint256 agentId, AttestGate.Requirement[] memory requirements)
        public
        pure
        returns (address)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, SALT, keccak256(initCode(registry, agentId, requirements)))
        );
        return address(uint160(uint256(digest)));
    }

    function initCode(address registry, uint256 agentId, AttestGate.Requirement[] memory requirements)
        public
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(type(DemoAgentVault).creationCode, abi.encode(registry, agentId, requirements));
    }

    function _deployCalldata(address registry, uint256 agentId, AttestGate.Requirement[] memory requirements)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(SALT, initCode(registry, agentId, requirements));
    }
}
