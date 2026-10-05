// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {FindingsBoard} from "../src/FindingsBoard.sol";

/// @notice The findings envelope's binding (ARCHITECTURE §6) against packages/sdk/test/inbox-vectors.json, whose values
/// come from node:crypto (make-inbox-vectors.ts): the AAD the SDK seals under must be exactly Solidity's `abi.encode`
/// of the context, and the topic readers filter on must be `FindingsPosted`'s. Every value is read from the file (the
/// board's address is a recorded literal there), so the vector doesn't depend on the deploy script or the bytecode.
contract InboxVectorsTest is Test {
    using stdJson for string;

    string internal constant VECTORS = "../packages/sdk/test/inbox-vectors.json";

    function test_Aad_IsSolidityAbiEncode() public view {
        string memory json = vm.readFile(VECTORS);
        bytes memory expected = abi.encode(
            json.readUint(".context.chainId"),
            json.readAddress(".context.findingsBoard"),
            json.readAddress(".context.validationRegistry"),
            json.readBytes32(".context.requestHash"),
            json.readUint(".context.agentId"),
            json.readAddress(".context.validator"),
            json.readBytes32(".context.recipient")
        );
        assertEq(expected.length, 224, "aad length");
        assertEq(expected, vm.parseJsonBytes(json, ".aad"));
        assertEq(json.readUint(".context.chainId"), 10143, "chain");
        assertEq(json.readUint(".context.agentId"), 1984, "agent");
    }

    function test_Topic_IsFindingsPostedSelector() public view {
        string memory json = vm.readFile(VECTORS);
        assertEq(FindingsBoard.FindingsPosted.selector, vm.parseJsonBytes32(json, ".findingsPostedTopic"));
    }
}
