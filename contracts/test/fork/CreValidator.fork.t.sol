// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {AttestGate} from "../../src/AttestGate.sol";
import {CreValidator} from "../../src/CreValidator.sol";
import {IValidationRegistry} from "../../src/interfaces/IValidationRegistry.sol";
import {DeployCreValidator} from "../../script/DeployCreValidator.s.sol";
import {IERC8004IdentityRegistry} from "./ValidationRegistry.fork.t.sol";

/// The parts of Chainlink's MockKeystoneForwarder (chainlink-evm, contracts/cre/src/dev) this test
/// drives. The build deployed on Monad testnet verifies no signatures and exposes route() publicly.
interface IMockKeystoneForwarder {
    event ReportProcessed(
        address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result
    );

    function report(address receiver, bytes calldata rawReport, bytes calldata reportContext, bytes[] calldata) external;
    function route(
        bytes32 transmissionId,
        address transmitter,
        address receiver,
        bytes calldata metadata,
        bytes calldata validatedReport
    ) external returns (bool);
    function typeAndVersion() external view returns (string memory);
}

/// @notice CreValidator (validator C, P11) against Monad testnet's live MockKeystoneForwarder, the
/// live ValidationRegistry, the canonical Identity Registry and the live two-validator vault.
/// Skipped when MONAD_TESTNET_RPC_URL is unset.
contract CreValidatorForkTest is Test {
    IMockKeystoneForwarder internal constant MOCK = IMockKeystoneForwarder(0xB9F79d863261869B234c481D1f9A7af84AeAd192);
    IValidationRegistry internal constant REGISTRY = IValidationRegistry(0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f);
    IERC8004IdentityRegistry internal constant IDENTITY =
        IERC8004IdentityRegistry(0x8004A818BFB912233c491871b3d84c89A494BD9e);
    /// The live DemoAgentVault (agent 1984), and validators A and B it requires.
    AttestGate internal constant VAULT = AttestGate(0x12fAb3E3cA810Cc44bD9f537613a230a2be8D614);
    address internal constant VALIDATOR_A = 0xa62DaB21E0C0F57e94B3ed6e675F214199989e92;
    address internal constant VALIDATOR_B = 0x780df855b48AeC7A3907433b0b5984A2fe5dca5E;

    bytes32 internal constant EXECUTION_ID = keccak256("attest8004.fork.cre.execution");
    string internal constant RESPONSE_URI = "data:application/json;base64,e30=";
    bytes32 internal constant RESPONSE_HASH = keccak256("{}");

    DeployCreValidator internal script;
    CreValidator internal c;
    address internal owner = makeAddr("agentOwner");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        script = new DeployCreValidator();
        c = script.deploy();
    }

    // ---------------------------------------------------------------- helpers

    /// The 109-byte header the CRE simulator writes (P11 spike): version 1, the execution id, the
    /// fixed timestamp 100, DON 1, config 1, workflowId 0x11…11, our name, the placeholder owner, 0x0001.
    function _rawReport(bytes32 executionId, bytes memory payload) internal view returns (bytes memory) {
        return abi.encodePacked(
            uint8(1),
            executionId,
            uint32(100),
            uint32(1),
            uint32(1),
            bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111)),
            script.WORKFLOW_NAME(),
            script.SIM_WORKFLOW_OWNER(),
            bytes2(0x0001),
            payload
        );
    }

    function _requestC() internal returns (bytes32 requestHash) {
        vm.prank(owner);
        uint256 agentId = IDENTITY.register("data:application/json,{\"name\":\"attest8004-cre-fork\"}");
        requestHash = keccak256(abi.encode("attest8004.fork.cre.request", agentId));
        vm.prank(owner);
        REGISTRY.validationRequest(address(c), agentId, "data:application/json,{}", requestHash);
    }

    function _payload(bytes32 requestHash, uint8 score, bytes32 responseHash) internal pure returns (bytes memory) {
        return abi.encode(requestHash, score, RESPONSE_URI, responseHash);
    }

    function _status(bytes32 requestHash) internal view returns (address v, uint8 score, bytes32 h, string memory t) {
        (v,, score, h, t,) = REGISTRY.getValidationStatus(requestHash);
    }

    // ---------------------------------------------------------------- tests

    function testFork_mockForwarderIsLive() public view {
        assertGt(address(MOCK).code.length, 0, "mock forwarder has code");
        assertEq(MOCK.typeAndVersion(), "MockKeystoneForwarder 1.0.0");
    }

    function testFork_reportThroughMockWritesVerdict() public {
        bytes32 rh = _requestC();
        vm.expectEmit(true, true, true, true, address(MOCK));
        emit IMockKeystoneForwarder.ReportProcessed(address(c), EXECUTION_ID, bytes2(0x0001), true);
        vm.prank(stranger); // the mock checks no signature and no transmitter
        MOCK.report(
            address(c), _rawReport(EXECUTION_ID, _payload(rh, 100, RESPONSE_HASH)), new bytes(96), new bytes[](0)
        );

        (address v, uint8 score, bytes32 h, string memory t) = _status(rh);
        assertEq(v, address(c));
        assertEq(score, 100);
        assertEq(h, RESPONSE_HASH);
        assertEq(t, "mandate-v1");
    }

    /// The forwarder catches C's revert: the transaction succeeds and only ReportProcessed's result
    /// says the verdict didn't land. So a "successful" write is never proof (docs/cre.md).
    function testFork_mockSwallowsReceiverRevert() public {
        bytes32 rh = _requestC();
        MOCK.report(
            address(c), _rawReport(EXECUTION_ID, _payload(rh, 100, RESPONSE_HASH)), new bytes(96), new bytes[](0)
        );

        bytes32 second = keccak256("attest8004.fork.cre.second");
        vm.expectEmit(true, true, true, true, address(MOCK));
        emit IMockKeystoneForwarder.ReportProcessed(address(c), second, bytes2(0x0001), false);
        MOCK.report(address(c), _rawReport(second, _payload(rh, 0, keccak256("forged"))), new bytes(96), new bytes[](0));

        (, uint8 score, bytes32 h,) = _status(rh);
        assertEq(score, 100, "the first verdict stays (write-once)");
        assertEq(h, RESPONSE_HASH);
    }

    /// Anyone can call the deployed mock's route() with any metadata and reach onReport: C on the
    /// mock is not a trust root, and whoever delivers first fills its slot.
    function testFork_anyoneCanReachCThroughMockRoute() public {
        bytes32 rh = _requestC();
        bytes memory forgedMetadata = abi.encodePacked(
            bytes32("forged-workflow-id"), script.WORKFLOW_NAME(), script.SIM_WORKFLOW_OWNER(), bytes2(0x0001)
        );
        vm.prank(stranger);
        bool ok = MOCK.route(bytes32("any"), stranger, address(c), forgedMetadata, _payload(rh, 0, keccak256("forged")));
        assertTrue(ok, "a stranger's route() reached onReport");

        (address v, uint8 score, bytes32 h,) = _status(rh);
        assertEq(v, address(c));
        assertEq(score, 0);
        assertEq(h, keccak256("forged"));
    }

    /// NO GATE MAY REQUIRE C: the live vault requires exactly validators A and B.
    function testFork_liveVaultExcludesC() public view {
        AttestGate.Requirement[] memory reqs = VAULT.requirements();
        assertEq(reqs.length, 2, "two requirements");
        assertEq(reqs[0].validator, VALIDATOR_A);
        assertEq(reqs[1].validator, VALIDATOR_B);
        for (uint256 i; i < reqs.length; ++i) {
            assertTrue(reqs[i].validator != script.predictedAddress(), "the vault must not require C");
        }
    }
}
