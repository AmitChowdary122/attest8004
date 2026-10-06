// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {FindingsBoard} from "../src/FindingsBoard.sol";

/// @notice Deploys FindingsBoard through the canonical CREATE2 factory, with a literal gas limit
/// (Monad charges for the gas limit, not the gas used). Re-running is a no-op once the contract
/// exists. Run it with `script/deploy-testnet.sh FindingsBoard`, which first checks Monad's
/// eth_estimateGas for this call against DEPLOY_GAS (see deployPlan). The board has no constructor
/// arguments, so its address is the same on every chain the factory exists on.
contract DeployFindingsBoard is Script {
    // CREATE2_FACTORY (0x4e59b448…956C) is inherited from forge-std's CommonBase.
    bytes32 public constant SALT = keccak256("attest8004.FindingsBoard.v1");
    /// Literal gas limit for the deploy transaction. Monad testnet eth_estimateGas for this
    /// call on 5 Oct 2026 was 154,319; the limit is that x 1.2, rounded up to 10k.
    uint256 public constant DEPLOY_GAS = 190_000;

    error UnsupportedChain(uint256 chainId);
    error DeployFailed(address predicted);

    function run() external returns (FindingsBoard board) {
        if (block.chainid != 10143) revert UnsupportedChain(block.chainid);

        // deploy-testnet.sh passes the key in the environment, never on the command line (P12, AUD-07).
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        board = deploy();
        vm.stopBroadcast();

        require(board.MAX_ENVELOPE_BYTES() == 8192, "unexpected envelope cap");
        console2.log("chainId      ", block.chainid);
        console2.log("FindingsBoard", address(board));
    }

    /// @notice Deploys at `predictedAddress()`, or returns the existing contract.
    function deploy() public returns (FindingsBoard) {
        address predicted = predictedAddress();
        if (predicted.code.length == 0) {
            (bool ok, bytes memory ret) = CREATE2_FACTORY.call{gas: DEPLOY_GAS}(_deployCalldata());
            if (!ok || ret.length != 20 || address(bytes20(ret)) != predicted) revert DeployFailed(predicted);
        }
        return FindingsBoard(predicted);
    }

    /// @notice The exact transaction deploy() broadcasts on `chainId`, so the wrapper can compare
    /// the node's gas estimate with the limit before sending. Only testnet is supported so far.
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
        return type(FindingsBoard).creationCode;
    }

    function _deployCalldata() internal pure returns (bytes memory) {
        return abi.encodePacked(SALT, initCode());
    }
}
