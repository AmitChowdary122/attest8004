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

/** The read side of an AttestGate consumer (contracts/src/AttestGate.sol), plus its errors. */
export const attestGateAbi = parseAbi([
  "struct Action { uint256 agentId; address target; uint256 value; bytes data; uint64 deadline; bytes32 salt; }",
  "struct Requirement { address validator; uint8 minScore; }",
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
]);
