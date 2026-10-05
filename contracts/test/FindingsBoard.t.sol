// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test, Vm} from "forge-std/Test.sol";
import {FindingsBoard} from "../src/FindingsBoard.sol";

/// FindingsBoard (SPEC §4.7, P7): an immutable board that only emits. It judges nothing: a reader
/// trusts a post only when the ValidationRegistry names its validator and agent for that request.
contract FindingsBoardTest is Test {
    event FindingsPosted(
        bytes32 indexed requestHash, uint256 indexed agentId, address indexed validator, bytes envelope
    );

    bytes32 internal constant REQUEST = keccak256("attest8004.test.request");
    uint256 internal constant AGENT = 1984;

    FindingsBoard internal board;
    address internal validator = makeAddr("validator");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        board = new FindingsBoard();
    }

    function _envelope(uint256 length) internal pure returns (bytes memory envelope) {
        envelope = new bytes(length);
        for (uint256 i; i < length; ++i) {
            envelope[i] = bytes1(uint8(i * 7 + 1));
        }
    }

    function test_Post_EmitsFindingsPosted_SenderIsValidator() public {
        bytes memory envelope = _envelope(100);
        vm.expectEmit(true, true, true, true, address(board));
        emit FindingsPosted(REQUEST, AGENT, validator, envelope);
        vm.prank(validator);
        board.post(REQUEST, AGENT, envelope);
    }

    /// Anyone can post; the post names its sender. Whether it is trusted is the reader's rule.
    function test_Post_AnyCallerCanPost() public {
        bytes memory envelope = _envelope(61);
        vm.expectEmit(true, true, true, true, address(board));
        emit FindingsPosted(REQUEST, AGENT, stranger, envelope);
        vm.prank(stranger);
        board.post(REQUEST, AGENT, envelope);
    }

    function test_Post_Accepts8192Bytes() public {
        bytes memory envelope = _envelope(8192);
        vm.recordLogs();
        vm.prank(validator);
        board.post(REQUEST, AGENT, envelope);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(abi.decode(logs[0].data, (bytes)), envelope);
    }

    function test_Post_RevertsAt8193() public {
        bytes memory envelope = _envelope(8193);
        vm.expectRevert(abi.encodeWithSelector(FindingsBoard.EnvelopeTooLarge.selector, 8193, 8192));
        vm.prank(validator);
        board.post(REQUEST, AGENT, envelope);
    }

    /// There is no minimum length: readers ignore an envelope they can't parse (Decision 1).
    function test_Post_EmptyEnvelopeIsEmitted() public {
        vm.expectEmit(true, true, true, true, address(board));
        emit FindingsPosted(REQUEST, AGENT, validator, "");
        vm.prank(validator);
        board.post(REQUEST, AGENT, "");
    }

    function test_Post_RejectsValue() public {
        vm.deal(validator, 1 ether);
        vm.prank(validator);
        (bool ok,) = address(board).call{value: 1}(abi.encodeCall(FindingsBoard.post, (REQUEST, AGENT, _envelope(10))));
        assertFalse(ok);
        assertEq(address(board).balance, 0);
    }

    function test_NoStorage() public {
        vm.record();
        vm.prank(validator);
        board.post(REQUEST, AGENT, _envelope(500));
        (bytes32[] memory reads, bytes32[] memory writes) = vm.accesses(address(board));
        assertEq(reads.length, 0, "reads");
        assertEq(writes.length, 0, "writes");
    }

    function test_MaxEnvelopeBytes() public view {
        assertEq(board.MAX_ENVELOPE_BYTES(), 8192);
    }

    /// The compiled ABI is post, the cap, the event and the error: no admin, no setter, no owner.
    function test_Abi_IsExactlyPostCapEventError() public view {
        string memory artifact = vm.readFile("out/FindingsBoard.sol/FindingsBoard.json");
        string[] memory methods = vm.parseJsonKeys(artifact, ".methodIdentifiers");
        assertEq(methods.length, 2, "function count");
        string[] memory names = abi.decode(vm.parseJson(artifact, ".abi[*].name"), (string[]));
        string[4] memory want = ["post", "MAX_ENVELOPE_BYTES", "FindingsPosted", "EnvelopeTooLarge"];
        assertEq(names.length, want.length, "abi entry count");
        for (uint256 i; i < want.length; ++i) {
            bool found;
            for (uint256 j; j < names.length; ++j) {
                if (keccak256(bytes(names[j])) == keccak256(bytes(want[i]))) found = true;
            }
            assertTrue(found, want[i]);
        }
    }

    function testFuzz_Post_EmitsInputs(bytes32 requestHash, uint256 agentId, address caller, bytes memory envelope)
        public
    {
        vm.assume(envelope.length <= 8192);
        vm.expectEmit(true, true, true, true, address(board));
        emit FindingsPosted(requestHash, agentId, caller, envelope);
        vm.prank(caller);
        board.post(requestHash, agentId, envelope);
    }

    function testFuzz_Post_RevertsAboveCap(uint16 extra) public {
        uint256 length = 8193 + uint256(extra) % 4096;
        vm.expectRevert(abi.encodeWithSelector(FindingsBoard.EnvelopeTooLarge.selector, length, 8192));
        vm.prank(validator);
        board.post(REQUEST, AGENT, _envelope(length));
    }
}
