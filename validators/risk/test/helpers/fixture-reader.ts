/**
 * The chain side of `risk-v1`'s recorded runs (P5 Task 13, Ruling R5): a `RiskReader` that answers
 * from a synthetic scenario file (`test/fixtures/chain/scenario-*.json`), and the rest of what
 * `runRiskV1` needs for one variant of it (the request, `P`, validator A's verdict). One source of
 * chain answers for both `scripts/record-fixtures.ts` (which records live model runs over it) and
 * `injection.test.ts` (which replays them), so the two always send the model the same tool outputs.
 * No network: every answer comes from the file.
 */
import { buildAction, buildRequestJson, computeRequestHash, DEPLOYMENTS, requestHashOfJson } from "@attest8004/sdk";
import { mandateRequestOf, type MandateInputs, type MandateRecord, type PermissionEvent, type PinnedBlock } from "@attest8004/validator-mandate";
import { readFileSync } from "node:fs";
import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { riskAddressesAt, riskContractsFor, type RiskAddresses, type RiskReader } from "../../src/reader.ts";
import type { CallFrame, TraceResult } from "../../src/trace.ts";
import type { Prerequisite } from "../../src/types.ts";

export type ScenarioName = "passthrough" | "safe" | "reset";

interface ScenarioAccount {
  label: string;
  code: Hex;
  /** Code present, and the nonce non-zero, from this block on; `null`: never. */
  createdAtBlock: string | null;
  balance: string;
  nonce: string;
  agentsOwned: string | null;
}

/** The scenario file's shape (see each file's `_comment`). Numbers are decimal strings. */
export interface ScenarioFile {
  chainId: number;
  pinned: { number: string; hash: Hex; timestamp: string };
  requestBlock: string;
  gate: Address;
  action: { agentId: string; target: Address; value: string; deadline: string; salt: Hex };
  variants: Record<string, { memo: string | null; data: Hex }>;
  prerequisite: { score: number; reasons: string[] };
  owner: Address;
  mandate: {
    allowedTargets: Address[];
    allowedSelectors: Hex[];
    maxValuePerTx: string;
    maxValuePerDay: string;
    validUntil: string;
    mandateHash: Hex;
    owner: Address;
    setAtBlock: string;
  } | null;
  permissionEvents: Array<{ block: string; logIndex: number; txHash: Hex; emitter: PermissionEvent["emitter"]; event: PermissionEvent["event"] }>;
  /** The root frame's `input` is the variant's data. */
  trace: Omit<CallFrame, "input">;
  accounts: Record<string, ScenarioAccount>;
  agents: Record<string, Address>;
}

/** Everything `runRiskV1` takes besides the LLM, the guard and Nansen, for one scenario variant. */
export interface ScenarioRun {
  reader: FixtureRiskReader;
  request: MandateInputs["request"];
  pinned: PinnedBlock;
  prerequisite: Prerequisite;
  addresses: RiskAddresses;
  mandateValidator: Address;
  /** The variant's memo (the text planted in its calldata), or `null`. */
  memo: string | null;
}

export function loadScenario(name: ScenarioName): ScenarioFile {
  const url = new URL(`../fixtures/chain/scenario-${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as ScenarioFile;
}

/** A `RiskReader` answering from a {@link ScenarioFile} at its pinned block (and, for age probes, below it). */
export class FixtureRiskReader implements RiskReader {
  private readonly scenario: ScenarioFile;
  private readonly data: Hex;
  private readonly pinnedBlock: PinnedBlock;
  private readonly accounts: Map<string, ScenarioAccount>;
  /** Every method call, in order (for tests that check what a run read). */
  readonly calls: string[] = [];

  constructor(scenario: ScenarioFile, data: Hex) {
    this.scenario = scenario;
    this.data = data;
    this.pinnedBlock = { number: BigInt(scenario.pinned.number), hash: scenario.pinned.hash, timestamp: BigInt(scenario.pinned.timestamp) };
    this.accounts = new Map();
    for (const [address, account] of Object.entries(scenario.accounts)) {
      if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(account.code)) throw new Error(`scenario: ${address}'s code is not whole bytes of hex`);
      this.accounts.set(getAddress(address).toLowerCase(), account);
    }
  }

  private atPinOnly(method: string, at: bigint): void {
    if (at !== this.pinnedBlock.number) throw new Error(`fixture reader: ${method} read at block ${at}, but the scenario only answers at P (${this.pinnedBlock.number})`);
  }

  private account(address: Address): ScenarioAccount | undefined {
    return this.accounts.get(address.toLowerCase());
  }

  private created(account: ScenarioAccount | undefined, at: bigint): boolean {
    return account !== undefined && account.createdAtBlock !== null && at >= BigInt(account.createdAtBlock);
  }

  private notInFixture(method: string): never {
    throw new Error(`fixture reader: ${method} is not part of a recorded run`);
  }

  async chainId() {
    this.calls.push("chainId");
    return this.scenario.chainId;
  }
  async finalized(): Promise<PinnedBlock> {
    return this.notInFixture("finalized");
  }
  async block(number: bigint): Promise<PinnedBlock> {
    this.calls.push("block");
    this.atPinOnly("block", number);
    return { ...this.pinnedBlock };
  }
  async mandate(_agentId: bigint, at: bigint): Promise<MandateRecord | null> {
    this.calls.push("mandate");
    this.atPinOnly("mandate", at);
    const m = this.scenario.mandate;
    if (m === null) return null;
    return {
      allowedTargets: m.allowedTargets.map((a) => getAddress(a)),
      allowedSelectors: [...m.allowedSelectors],
      maxValuePerTx: BigInt(m.maxValuePerTx),
      maxValuePerDay: BigInt(m.maxValuePerDay),
      validUntil: BigInt(m.validUntil),
      mandateHash: m.mandateHash,
      owner: getAddress(m.owner),
      setAtBlock: BigInt(m.setAtBlock),
    };
  }
  async ownerOf(_agentId: bigint, at: bigint): Promise<Address> {
    this.calls.push("ownerOf");
    this.atPinOnly("ownerOf", at);
    return getAddress(this.scenario.owner);
  }
  async agentValidations(): Promise<Hex[]> {
    return this.notInFixture("agentValidations");
  }
  async status(): Promise<never> {
    return this.notInFixture("status");
  }
  async consumed(): Promise<boolean | null> {
    return this.notInFixture("consumed");
  }
  async permissionLogs(fromBlock: bigint, toBlock: bigint): Promise<Omit<PermissionEvent, "afterMandate">[]> {
    this.calls.push("permissionLogs");
    return this.scenario.permissionEvents
      .map((e) => ({ ...e, block: BigInt(e.block) }))
      .filter((e) => e.block >= fromBlock && e.block <= toBlock);
  }
  async simulate(): Promise<never> {
    return this.notInFixture("simulate");
  }
  async responseEvidence(): Promise<string | null> {
    return this.notInFixture("responseEvidence");
  }
  async responseLog(): Promise<never> {
    return this.notInFixture("responseLog");
  }
  async requestUri(): Promise<string | null> {
    return this.notInFixture("requestUri");
  }
  async trace(call: { from: Address; to: Address; value: bigint; data: Hex; gas: bigint }, at: bigint): Promise<TraceResult> {
    this.calls.push("trace");
    this.atPinOnly("trace", at);
    if (call.data.toLowerCase() !== this.data.toLowerCase()) throw new Error("fixture reader: trace asked for other calldata than the variant's");
    const frame = structuredClone(this.scenario.trace) as CallFrame;
    frame.input = this.data;
    return { ok: true, frame };
  }
  async code(address: Address, at: bigint): Promise<Hex> {
    this.calls.push("code");
    const account = this.account(address);
    return this.created(account, at) ? (account as ScenarioAccount).code : "0x";
  }
  async balance(address: Address, at: bigint): Promise<bigint> {
    this.calls.push("balance");
    this.atPinOnly("balance", at);
    return BigInt(this.account(address)?.balance ?? "0");
  }
  async nonce(address: Address, at: bigint): Promise<bigint> {
    this.calls.push("nonce");
    const account = this.account(address);
    return this.created(account, at) ? BigInt((account as ScenarioAccount).nonce) : 0n;
  }
  async agentOwner(agentId: bigint, at: bigint): Promise<Address | null> {
    this.calls.push("agentOwner");
    this.atPinOnly("agentOwner", at);
    const owner = this.scenario.agents[agentId.toString()];
    return owner === undefined ? null : getAddress(owner);
  }
  async agentsOwned(address: Address, at: bigint): Promise<bigint | null> {
    this.calls.push("agentsOwned");
    this.atPinOnly("agentsOwned", at);
    const account = this.account(address);
    if (account === undefined) return 0n;
    return account.agentsOwned === null ? null : BigInt(account.agentsOwned);
  }
  async reputationClients(_agentId: bigint, at: bigint): Promise<Address[]> {
    this.calls.push("reputationClients");
    this.atPinOnly("reputationClients", at);
    return [];
  }
  async reputationSummary(): Promise<{ count: bigint; value: bigint; decimals: number }> {
    return this.notInFixture("reputationSummary (no agent has clients)");
  }
}

/**
 * One variant of a scenario as `runRiskV1`'s inputs: the request to validator B (the SDK's own
 * request JSON and hash), `P`, and validator A's verdict on the same action at `P` (its request hash
 * computed for validator A; a synthetic `responseHash`, which never reaches the model).
 */
export function scenarioRun(name: ScenarioName, variant: string): ScenarioRun {
  const scenario = loadScenario(name);
  const v = scenario.variants[variant];
  if (v === undefined) throw new Error(`scenario ${name} has no variant "${variant}"`);
  const deployment = DEPLOYMENTS[10143];
  const action = buildAction({
    agentId: BigInt(scenario.action.agentId),
    target: scenario.action.target,
    value: BigInt(scenario.action.value),
    data: v.data,
    deadline: BigInt(scenario.action.deadline),
    salt: scenario.action.salt,
  });
  const jsonB = buildRequestJson({ chainId: scenario.chainId, gate: scenario.gate, validator: deployment.validators.riskV1, action });
  const requestHashA = computeRequestHash({ chainId: scenario.chainId, gate: scenario.gate, validator: deployment.validators.mandateV1, action }).toLowerCase() as Hex;
  const reader = new FixtureRiskReader(scenario, v.data);
  return {
    reader,
    request: mandateRequestOf(jsonB, requestHashOfJson(jsonB), BigInt(scenario.requestBlock)),
    pinned: { number: BigInt(scenario.pinned.number), hash: scenario.pinned.hash, timestamp: BigInt(scenario.pinned.timestamp) },
    prerequisite: {
      validator: deployment.validators.mandateV1,
      requestHash: requestHashA,
      score: scenario.prerequisite.score,
      responseHash: keccak256(stringToBytes(`attest8004.fixture.mandate-v1-evidence ${requestHashA}`)),
      tag: "mandate-v1",
      reasons: [...scenario.prerequisite.reasons],
    },
    addresses: riskAddressesAt(riskContractsFor(scenario.chainId), BigInt(scenario.pinned.number)),
    mandateValidator: deployment.validators.mandateV1,
    memo: v.memo,
  };
}
