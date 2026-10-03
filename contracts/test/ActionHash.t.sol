// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Action} from "../src/ActionHash.sol";
import {ActionHashHarness} from "./mocks/ActionHashHarness.sol";

/// @notice SPEC §4.3: requestHash and actionHash must match the TypeScript SDK. Both suites check
/// packages/sdk/test/vectors.json, whose expected hashes come from cast (vectors.sh).
contract ActionHashTest is Test {
    using stdJson for string;

    string internal constant VECTORS = "../packages/sdk/test/vectors.json";

    ActionHashHarness internal harness;

    function setUp() public {
        harness = new ActionHashHarness();
    }

    function test_Vectors_MatchSdkFile() public view {
        string memory json = vm.readFile(VECTORS);
        uint256 n;
        while (vm.keyExistsJson(json, _key(n, ""))) {
            string memory name = json.readString(_key(n, ".name"));
            uint256 chainId = json.readUint(_key(n, ".chainId"));
            address gate = json.readAddress(_key(n, ".gate"));
            address validator = json.readAddress(_key(n, ".validator"));
            Action memory action = Action({
                agentId: json.readUint(_key(n, ".action.agentId")),
                target: json.readAddress(_key(n, ".action.target")),
                value: json.readUint(_key(n, ".action.value")),
                data: json.readBytes(_key(n, ".action.data")),
                deadline: uint64(json.readUint(_key(n, ".action.deadline"))),
                salt: json.readBytes32(_key(n, ".action.salt"))
            });

            assertEq(harness.actionHash(action, chainId, gate), json.readBytes32(_key(n, ".actionHash")), name);
            assertEq(
                harness.requestHash(action, chainId, gate, validator), json.readBytes32(_key(n, ".requestHash")), name
            );
            ++n;
        }
        assertGe(n, 8, "vector count");
    }

    function testFuzz_RequestHash_BindsValidator(Action calldata action, address v1, address v2) public view {
        vm.assume(v1 != v2);
        assertTrue(
            harness.requestHash(action, block.chainid, address(this), v1)
                != harness.requestHash(action, block.chainid, address(this), v2)
        );
    }

    function testFuzz_RequestHash_NeverEqualsActionHash(Action calldata action, uint256 chainId, address gate, address validator)
        public
        view
    {
        assertTrue(harness.requestHash(action, chainId, gate, validator) != harness.actionHash(action, chainId, gate));
    }

    function _key(uint256 i, string memory field) internal view returns (string memory) {
        return string.concat(".vectors[", vm.toString(i), "]", field);
    }
}
