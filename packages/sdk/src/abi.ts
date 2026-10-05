import { parseAbi, parseAbiItem } from "viem";

// The registry's errors, so a revert propagated through the forwarder still decodes by name.
const registryErrors = [
  "error ZeroValidator()",
  "error RequestExists(bytes32 requestHash)",
  "error NotAgentOwnerOrOperator(uint256 agentId, address caller)",
  "error UnknownRequest(bytes32 requestHash)",
  "error NotRequestedValidator(bytes32 requestHash, address caller)",
  "error ResponseOutOfRange(uint8 response)",
] as const;

/** The EIP-8004 ValidationRegistry (contracts/src/ValidationRegistry.sol). */
export const validationRegistryAbi = parseAbi([
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
  "function getSummary(uint256 agentId, address[] validatorAddresses, string tag) view returns (uint64 count, uint8 averageResponse)",
  "function getAgentValidations(uint256 agentId) view returns (bytes32[] requestHashes)",
  "function getValidatorRequests(address validatorAddress) view returns (bytes32[] requestHashes)",
  "function getIdentityRegistry() view returns (address)",
  "event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)",
  "event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  ...registryErrors,
]);

export const validationRequestEvent = parseAbiItem(
  "event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)",
);

export const validationResponseEvent = parseAbiItem(
  "event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
);

/** contracts/src/AgentRequestForwarder.sol: an agent's hot key requests validations through it. */
export const agentRequestForwarderAbi = parseAbi([
  "function request(address validator, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function setAgentKey(uint256 agentId, address key)",
  "function agentKeyOf(uint256 agentId) view returns (address key, address owner)",
  "function validationRegistry() view returns (address)",
  "function identityRegistry() view returns (address)",
  "event AgentKeySet(uint256 indexed agentId, address indexed owner, address indexed key)",
  "error NotAgentOwner(uint256 agentId, address caller)",
  "error NotAgentKey(uint256 agentId, address caller)",
  "error StaleAgentKey(uint256 agentId, address keyOwner, address currentOwner)",
  "error ERC721NonexistentToken(uint256 tokenId)",
  ...registryErrors,
]);

/** For filtering logs by this one event without the rest of agentRequestForwarderAbi. */
export const agentKeySetEvent = parseAbiItem(
  "event AgentKeySet(uint256 indexed agentId, address indexed owner, address indexed key)",
);

/**
 * contracts/src/MandateRegistry.sol, v2 (P6): an agent owner's per-agent spending mandate (SPEC §4.2) —
 * the targets and selectors an agent may act through, its per-tx/per-day MON caps, and its expiry —
 * where every change to the mandate, the passkey or the inbox key needs the owner's transaction and a
 * WebAuthn assertion (`WebAuthnAuth`) from the passkey bound to the agent; `revokeMandate` needs the
 * owner only. `getMandate`, `mandateHashOf`, `identityRegistry`, `MandateSet` and `MandateRevoked` are
 * exactly P4's, so this one ABI reads and decodes every registry in `Deployment.mandateRegistries`.
 * `ERC721NonexistentToken` isn't the registry's own: it's the Identity Registry's error, propagated
 * unchanged when the registry calls `ownerOf` for an agent that was never registered.
 */
export const mandateRegistryAbi = parseAbi([
  "struct Mandate { address[] allowedTargets; bytes4[] allowedSelectors; uint256 maxValuePerTx; uint256 maxValuePerDay; uint64 validUntil; }",
  "struct WebAuthnAuth { bytes32 r; bytes32 s; uint256 challengeIndex; uint256 typeIndex; bytes authenticatorData; string clientDataJSON; }",
  "function setPasskey(uint256 agentId, bytes32 qx, bytes32 qy)",
  "function rotatePasskey(uint256 agentId, bytes32 qx, bytes32 qy, WebAuthnAuth auth)",
  "function setMandate(uint256 agentId, Mandate mandate, WebAuthnAuth auth)",
  "function revokeMandate(uint256 agentId)",
  "function setInboxKey(uint256 agentId, bytes32 x25519Pub, WebAuthnAuth auth)",
  "function getMandate(uint256 agentId) view returns (Mandate mandate, bytes32 mandateHash, address owner, uint64 setAtBlock)",
  "function passkeyOf(uint256 agentId) view returns (bytes32 qx, bytes32 qy)",
  "function nonceOf(uint256 agentId) view returns (uint256)",
  "function inboxKeyOf(uint256 agentId) view returns (bytes32)",
  "function mandateHashOf(Mandate mandate) pure returns (bytes32)",
  "function challengeFor(uint256 agentId, bytes32 changeHash, uint256 nonce) view returns (bytes32)",
  "function identityRegistry() view returns (address)",
  "function rpIdHash() view returns (bytes32)",
  "function MAX_TARGETS() view returns (uint256)",
  "function MAX_SELECTORS() view returns (uint256)",
  "function ROTATE_PASSKEY() view returns (bytes32)",
  "function SET_INBOX_KEY() view returns (bytes32)",
  "event PasskeySet(uint256 indexed agentId, address indexed owner, bytes32 qx, bytes32 qy)",
  "event PasskeyRotated(uint256 indexed agentId, address indexed owner, bytes32 oldQx, bytes32 oldQy, bytes32 qx, bytes32 qy)",
  "event InboxKeySet(uint256 indexed agentId, address indexed owner, bytes32 x25519Pub)",
  "event MandateSet(uint256 indexed agentId, bytes32 indexed mandateHash, address indexed owner, address[] allowedTargets, bytes4[] allowedSelectors, uint256 maxValuePerTx, uint256 maxValuePerDay, uint64 validUntil, uint64 setAtBlock)",
  "event MandateRevoked(uint256 indexed agentId, bytes32 indexed mandateHash, address indexed owner)",
  "error ZeroIdentityRegistry()",
  "error ZeroRpIdHash()",
  "error NotAgentOwner(uint256 agentId, address caller)",
  "error NoPasskey(uint256 agentId)",
  "error PasskeyAlreadySet(uint256 agentId)",
  "error InvalidPasskey(bytes32 qx, bytes32 qy)",
  "error WrongRpIdHash(bytes32 expected, bytes32 actual)",
  "error InvalidAssertion(uint256 agentId)",
  "error ZeroInboxKey()",
  "error MandateAlreadyExpired(uint64 validUntil, uint256 timestamp)",
  "error TooManyTargets(uint256 count)",
  "error TooManySelectors(uint256 count)",
  "error ZeroTarget()",
  "error TxCapAboveDailyCap(uint256 maxValuePerTx, uint256 maxValuePerDay)",
  "error NoMandate(uint256 agentId)",
  "error ERC721NonexistentToken(uint256 tokenId)",
]);

/**
 * The subset of the canonical ERC-8004 Identity Registry (an ERC-721) that the mandate flow reads:
 * who owns or operates an agent, and the transfer/approval events that mark a mandate stale
 * (`MANDATE_OWNER_CHANGED`) or require a permission-change check.
 */
export const identityRegistryAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function approve(address to, uint256 tokenId)",
  "function setApprovalForAll(address operator, bool approved)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
  "error ERC721NonexistentToken(uint256 tokenId)",
]);

/**
 * The canonical ERC-8004 ReputationRegistry (CLAUDE.md), testnet/mainnet addresses in
 * `DEPLOYMENTS[chainId].reputationRegistry`, version `"2.0.0"`: `risk-v1`'s `erc8004_reputation` tool
 * reads an agent's clients and their aggregate feedback. `getSummary` with an empty `clientAddresses`
 * reverts (`"clientAddresses required"`), so callers skip it when `getClients` returns none.
 */
export const reputationRegistryAbi = parseAbi([
  "function getClients(uint256 agentId) view returns (address[])",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
]);

/** The read side of an AttestGate consumer (contracts/src/AttestGate.sol), plus its errors. */
export const attestGateAbi = parseAbi([
  "struct Action { uint256 agentId; address target; uint256 value; bytes data; uint64 deadline; bytes32 salt; }",
  "struct Requirement { address validator; uint8 minScore; bytes32 tagHash; }",
  "function validationRegistry() view returns (address)",
  "function requirements() view returns (Requirement[])",
  "function consumed(bytes32 actionHash) view returns (bool)",
  "function actionHashOf(Action action) view returns (bytes32)",
  "function requestHashOf(Action action, address validator) view returns (bytes32)",
  "event ActionConsumed(bytes32 indexed actionHash, uint256 indexed agentId)",
  "error ActionExpired(uint64 deadline, uint256 timestamp)",
  "error ActionAlreadyConsumed(bytes32 actionHash)",
  "error ValidationNotFound(address validator, bytes32 requestHash)",
  "error ValidatorMismatch(bytes32 requestHash, address expected, address actual)",
  "error AgentMismatch(bytes32 requestHash, uint256 expected, uint256 actual)",
  "error ScoreTooLow(address validator, bytes32 requestHash, uint8 response, uint8 minScore)",
  "error ZeroTagHash(address validator)",
  "error TagMismatch(address validator, bytes32 requestHash, bytes32 expected, bytes32 actual)",
]);

/**
 * contracts/src/FindingsBoard.sol (P7): validators' encrypted operator reports. It stores nothing and judges
 * nothing; readers keep a post only when `getValidationStatus` names its validator and agent.
 */
export const findingsBoardAbi = parseAbi([
  "function post(bytes32 requestHash, uint256 agentId, bytes envelope)",
  "function MAX_ENVELOPE_BYTES() view returns (uint256)",
  "event FindingsPosted(bytes32 indexed requestHash, uint256 indexed agentId, address indexed validator, bytes envelope)",
  "error EnvelopeTooLarge(uint256 length, uint256 max)",
]);

export const findingsPostedEvent = parseAbiItem(
  "event FindingsPosted(bytes32 indexed requestHash, uint256 indexed agentId, address indexed validator, bytes envelope)",
);
