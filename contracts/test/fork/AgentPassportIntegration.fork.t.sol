// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test, console} from "forge-std/Test.sol";
import {AttestGate} from "../../src/AttestGate.sol";
import {DemoAgentVault} from "../../src/DemoAgentVault.sol";
import {Action} from "../../src/ActionHash.sol";
import {IValidationRegistry} from "../../src/interfaces/IValidationRegistry.sol";
import {IERC8004IdentityRegistry} from "./ValidationRegistry.fork.t.sol";

// The three interfaces below copy only function, event and error signatures from AgentPassport's
// IJobEscrow and IAgentPassport (by agentfromzero, MIT; the source is verified on Sourcify for the
// addresses used here, docs/integrations.md). Their contracts are called on a fork, never changed.

/// @notice AgentPassport's JobEscrow v2 (IJobEscrow), the parts these tests drive.
interface IJobEscrowLike {
    struct OpenParams {
        uint256 agentId;
        address token;
        uint128 amount;
        uint64 deadline;
        uint64 reviewWindow;
        address verifier;
        bytes32 specHash;
        string endpoint;
    }

    /// `status` is IJobEscrow.Status: None, Open, Delivered, Released, Refunded, Disputed (0-5).
    struct Job {
        uint256 agentId;
        address hirer;
        address verifier;
        address token;
        uint128 amount;
        uint64 deadline;
        uint64 reviewWindow;
        uint64 deliveredAt;
        uint8 status;
        bytes32 specHash;
        bytes32 deliverableHash;
    }

    event JobReleased(uint256 indexed jobId, uint256 indexed agentId, address indexed releasedBy, uint256 amount);

    error InvalidStatus(uint256 jobId, uint8 current);
    error NotAuthorizedToRelease(uint256 jobId, address caller);

    function open(OpenParams calldata p) external returns (uint256 jobId);
    function deliver(uint256 jobId, bytes32 deliverableHash, string calldata deliverableURI) external;
    function release(uint256 jobId) external;
    function getJob(uint256 jobId) external view returns (Job memory);
    function version() external pure returns (string memory);
    function settlementToken() external view returns (address);
    function passport() external view returns (address);
    function identityRegistry() external view returns (address);
}

/// @notice AgentPassport (IAgentPassport), the parts these tests read.
interface IAgentPassportLike {
    struct Passport {
        uint64 jobsSettled;
        uint64 jobsRefunded;
        uint64 jobsDisputed;
        uint64 firstSeen;
        uint64 lastSettled;
        uint128 volumeSettled;
        address token;
    }

    function passportOf(uint256 agentId) external view returns (Passport memory);
    function isAttester(address attester) external view returns (bool);
}

/// @notice Circle's testnet USDC (a FiatToken proxy), the ERC-20 parts these tests use.
interface IFiatTokenLike {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice The canonical Identity Registry's payment-wallet read, which JobEscrow pays.
interface IAgentWalletLike {
    function getAgentWallet(uint256 agentId) external view returns (address);
}

/// @notice P10: an Attest8004 vault as the `verifier` of a job on AgentPassport's live JobEscrow v2,
/// on a fork of Monad testnet (latest block). The vault is our live DemoAgentVault (agent 1984,
/// mandate-v1 at 100 and risk-v1 at 80); JobEscrow, AgentPassport, Circle's USDC and the ERC-8004
/// registries are the deployed contracts. The verdicts are posted by pranking the vault's two
/// validators on the real ValidationRegistry. Nothing is broadcast: this proves the two compose
/// against their live bytecode, not that their team adopted it (docs/integrations.md).
/// Skipped when MONAD_TESTNET_RPC_URL is unset.
contract AgentPassportIntegrationForkTest is Test {
    IERC8004IdentityRegistry internal constant IDENTITY =
        IERC8004IdentityRegistry(0x8004A818BFB912233c491871b3d84c89A494BD9e);
    IValidationRegistry internal constant REGISTRY = IValidationRegistry(0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f);
    DemoAgentVault internal constant VAULT = DemoAgentVault(payable(0x12fAb3E3cA810Cc44bD9f537613a230a2be8D614));
    IJobEscrowLike internal constant ESCROW = IJobEscrowLike(0x41Cb9b1a7Ebe2e1a420d8Cd96D02a9009AC54355);
    IAgentPassportLike internal constant PASSPORT = IAgentPassportLike(0xd01EC5Fd5A9A4335D64600aDA4E010AA6fAF9d0A);
    IFiatTokenLike internal constant USDC = IFiatTokenLike(0x534b2f3A21130d7a60830c2Df862319e593943A3);

    uint256 internal constant VAULT_AGENT = 1984;
    uint128 internal constant AMOUNT = 100_000; // 0.10 USDC (6 decimals)
    uint8 internal constant STATUS_DELIVERED = 2;
    uint8 internal constant STATUS_RELEASED = 3;
    /// mandate-v1 simulates an action with a 1,000,000 gas cap (SPEC §4.5, rule 12).
    uint256 internal constant MANDATE_V1_SIMULATION_GAS = 1_000_000;
    string internal constant AGENT_URI = "data:application/json,{\"name\":\"attest8004-p10-fork-worker\"}";

    address internal hirer = makeAddr("hirer");
    address internal worker = makeAddr("worker");
    address internal stranger = makeAddr("stranger");

    uint256 internal workerAgent;
    address internal validatorA;
    address internal validatorB;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        vm.prank(worker);
        workerAgent = IDENTITY.register(AGENT_URI);
        AttestGate.Requirement[] memory reqs = VAULT.requirements();
        validatorA = reqs[0].validator;
        validatorB = reqs[1].validator;
    }

    function testFork_LiveWiring() public view {
        assertEq(ESCROW.version(), "2");
        assertEq(ESCROW.settlementToken(), address(USDC));
        assertEq(ESCROW.passport(), address(PASSPORT));
        assertEq(ESCROW.identityRegistry(), address(IDENTITY));
        assertTrue(PASSPORT.isAttester(address(ESCROW)), "JobEscrow is no longer an AgentPassport attester");
        // The copied signatures are theirs (the selectors their deployed code dispatches on).
        assertEq(IJobEscrowLike.open.selector, bytes4(0x25c566ab));
        assertEq(IJobEscrowLike.deliver.selector, bytes4(0x3fa602c3));
        assertEq(IJobEscrowLike.release.selector, bytes4(0x37bdc99b));

        assertEq(VAULT.agentId(), VAULT_AGENT);
        AttestGate.Requirement[] memory reqs = VAULT.requirements();
        assertEq(reqs.length, 2);
        assertEq(reqs[0].minScore, 100);
        assertEq(reqs[0].tagHash, keccak256("mandate-v1"));
        assertEq(reqs[1].minScore, 80);
        assertEq(reqs[1].tagHash, keccak256("risk-v1"));
    }

    function testFork_VaultReleasesDeliveredJob() public {
        uint256 jobId = _openAndDeliver();
        Action memory a = _release(jobId, "release");
        _verdicts(a, 100, 100);
        address payee = _payee();
        uint256 payeeBefore = USDC.balanceOf(payee);
        uint256 escrowBefore = USDC.balanceOf(address(ESCROW));
        uint64 settledBefore = PASSPORT.passportOf(workerAgent).jobsSettled;

        vm.expectEmit(true, true, true, true, address(ESCROW));
        emit IJobEscrowLike.JobReleased(jobId, workerAgent, address(VAULT), AMOUNT);
        VAULT.execute(a);

        assertEq(USDC.balanceOf(payee), payeeBefore + AMOUNT, "the worker's wallet is paid");
        assertEq(USDC.balanceOf(address(ESCROW)), escrowBefore - AMOUNT, "the escrow pays it");
        assertEq(ESCROW.getJob(jobId).status, STATUS_RELEASED);
        assertEq(PASSPORT.passportOf(workerAgent).jobsSettled, settledBefore + 1, "the passport records it");
        assertTrue(VAULT.consumed(VAULT.actionHashOf(a)));
    }

    function testFork_ReleaseWithoutVerdictsReverts() public {
        uint256 jobId = _openAndDeliver();
        Action memory a = _release(jobId, "no-verdicts");

        vm.expectRevert(
            abi.encodeWithSelector(
                AttestGate.ValidationNotFound.selector, validatorA, VAULT.requestHashOf(a, validatorA)
            )
        );
        VAULT.execute(a);
        assertEq(ESCROW.getJob(jobId).status, STATUS_DELIVERED, "the job is still waiting");
    }

    function testFork_ReleaseWithOnlyMandateVerdictReverts() public {
        uint256 jobId = _openAndDeliver();
        Action memory a = _release(jobId, "only-a");
        _verdict(a, validatorA, 100, "mandate-v1");

        vm.expectRevert(
            abi.encodeWithSelector(
                AttestGate.ValidationNotFound.selector, validatorB, VAULT.requestHashOf(a, validatorB)
            )
        );
        VAULT.execute(a);
    }

    function testFork_LowRiskScoreReverts() public {
        uint256 jobId = _openAndDeliver();
        Action memory a = _release(jobId, "risk-40");
        _verdicts(a, 100, 40);

        vm.expectRevert(
            abi.encodeWithSelector(
                AttestGate.ScoreTooLow.selector, validatorB, VAULT.requestHashOf(a, validatorB), uint8(40), uint8(80)
            )
        );
        VAULT.execute(a);
        assertEq(ESCROW.getJob(jobId).status, STATUS_DELIVERED);
    }

    function testFork_ReplayRevertsActionAlreadyConsumed() public {
        uint256 jobId = _openAndDeliver();
        Action memory a = _release(jobId, "replay");
        _verdicts(a, 100, 100);
        VAULT.execute(a);

        vm.expectRevert(abi.encodeWithSelector(AttestGate.ActionAlreadyConsumed.selector, VAULT.actionHashOf(a)));
        VAULT.execute(a);
    }

    /// Fresh verdicts for a new action can't pay twice: the escrow itself refuses a released job.
    function testFork_SecondReleaseFailsAtEscrow() public {
        uint256 jobId = _openAndDeliver();
        Action memory first = _release(jobId, "first");
        _verdicts(first, 100, 100);
        VAULT.execute(first);

        Action memory second = _release(jobId, "second");
        _verdicts(second, 100, 100);
        vm.expectRevert(
            abi.encodeWithSelector(
                DemoAgentVault.CallFailed.selector,
                abi.encodeWithSelector(IJobEscrowLike.InvalidStatus.selector, jobId, STATUS_RELEASED)
            )
        );
        VAULT.execute(second);
    }

    /// Before the review window ends, only the hirer and the verifier may release.
    function testFork_StrangerCannotRelease() public {
        uint256 jobId = _openAndDeliver();

        vm.expectRevert(abi.encodeWithSelector(IJobEscrowLike.NotAuthorizedToRelease.selector, jobId, stranger));
        vm.prank(stranger);
        ESCROW.release(jobId);
    }

    /// The verifier isn't exclusive (docs/integrations.md, caveat 1): once the review window has
    /// passed, anyone may release a delivered job, with no verdicts at all.
    function testFork_AnyoneCanReleaseAfterReviewWindow() public {
        uint256 jobId = _openAndDeliver();
        IJobEscrowLike.Job memory job = ESCROW.getJob(jobId);
        vm.warp(uint256(job.deliveredAt) + job.reviewWindow + 1);
        address payee = _payee();
        uint256 payeeBefore = USDC.balanceOf(payee);

        vm.expectEmit(true, true, true, true, address(ESCROW));
        emit IJobEscrowLike.JobReleased(jobId, workerAgent, stranger, AMOUNT);
        vm.prank(stranger);
        ESCROW.release(jobId);

        assertEq(USDC.balanceOf(payee), payeeBefore + AMOUNT, "paid without any verdict");
        assertEq(ESCROW.getJob(jobId).status, STATUS_RELEASED);
    }

    /// The action's own call (what mandate-v1 simulates from the vault) fits its gas cap, on an
    /// agent's first settlement (its passport record and first feedback are new storage, the
    /// costliest case). Logs that gas and a whole execute's on another first settlement, for
    /// docs/integrations.md.
    function testFork_ReleaseFitsMandateV1SimulationCap() public {
        uint256 direct = _openAndDeliver();
        vm.prank(address(VAULT));
        uint256 before = gasleft();
        ESCROW.release(direct);
        uint256 releaseGas = before - gasleft();
        assertLt(releaseGas, MANDATE_V1_SIMULATION_GAS);

        // A second fresh worker, so the execute below is also a first settlement.
        vm.prank(worker);
        workerAgent = IDENTITY.register(AGENT_URI);
        uint256 gated = _openAndDeliver();
        Action memory a = _release(gated, "gas");
        _verdicts(a, 100, 100);
        before = gasleft();
        VAULT.execute(a);
        uint256 executeGas = before - gasleft();

        console.log("release(jobId) from the vault, first settlement, frame gas:", releaseGas);
        console.log("vault.execute(release), first settlement, frame gas:", executeGas);
    }

    /// The hirer funds and opens a 0.10 USDC job for the worker agent, naming the vault as verifier;
    /// the worker delivers.
    function _openAndDeliver() internal returns (uint256 jobId) {
        uint256 funded = USDC.balanceOf(hirer) + AMOUNT;
        // forge-std's deal finds FiatToken v2.2's packed balance slot (the blacklist flag is its top bit).
        deal(address(USDC), hirer, funded);
        assertEq(USDC.balanceOf(hirer), funded, "deal funded the hirer");
        vm.startPrank(hirer);
        USDC.approve(address(ESCROW), AMOUNT);
        jobId = ESCROW.open(
            IJobEscrowLike.OpenParams({
                agentId: workerAgent,
                token: address(USDC),
                amount: AMOUNT,
                deadline: uint64(block.timestamp + 1 days),
                reviewWindow: 1 days,
                verifier: address(VAULT),
                specHash: keccak256("attest8004.p10.fork.spec"),
                endpoint: "attest8004-verifier-integration"
            })
        );
        vm.stopPrank();
        assertEq(ESCROW.getJob(jobId).verifier, address(VAULT));

        vm.prank(worker);
        ESCROW.deliver(jobId, keccak256(abi.encode("deliverable", jobId)), "data:application/json,{}");
        assertEq(ESCROW.getJob(jobId).status, STATUS_DELIVERED);
    }

    /// The vault's action that releases `jobId`: a call to the escrow, no value.
    function _release(uint256 jobId, string memory label) internal view returns (Action memory) {
        return Action({
            agentId: VAULT_AGENT,
            target: address(ESCROW),
            value: 0,
            data: abi.encodeCall(IJobEscrowLike.release, (jobId)),
            deadline: uint64(block.timestamp + 1 hours),
            salt: keccak256(abi.encode("attest8004.p10.fork", label, jobId, block.number))
        });
    }

    function _verdicts(Action memory a, uint8 scoreA, uint8 scoreB) internal {
        _verdict(a, validatorA, scoreA, "mandate-v1");
        _verdict(a, validatorB, scoreB, "risk-v1");
    }

    /// Agent 1984's owner requests `validator`'s verdict on the real registry, and the validator answers.
    function _verdict(Action memory a, address validator, uint8 score, string memory tag) internal {
        bytes32 rh = VAULT.requestHashOf(a, validator);
        vm.prank(IDENTITY.ownerOf(VAULT_AGENT));
        REGISTRY.validationRequest(validator, VAULT_AGENT, "data:application/json,{}", rh);
        vm.prank(validator);
        REGISTRY.validationResponse(rh, score, "", bytes32(0), tag);
    }

    /// Who JobEscrow pays: the worker agent's registered wallet, else its owner.
    function _payee() internal view returns (address payee) {
        payee = IAgentWalletLike(address(IDENTITY)).getAgentWallet(workerAgent);
        if (payee == address(0)) payee = IDENTITY.ownerOf(workerAgent);
    }
}
