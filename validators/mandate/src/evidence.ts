import { getAddress, keccak256, type Address, type Hex } from "viem";
import { MANDATE_V1 } from "./params.ts";
import type { MandateAddresses } from "./reader.ts";
import { selectorOf } from "./rules.ts";
import type { MandateInputs } from "./types.ts";

/**
 * The `mandate-v1` keys of an evidence document (ARCHITECTURE §6): everything the verdict was read
 * from at the pinned block `P`, added by `buildEvidence` after the base's `schema`, `validator`,
 * `requestHash`, `score` and `reasons`. None of them reuses a base key.
 *
 * - `block`: `P`'s number, hash and timestamp.
 * - `request`: the action's fields as the requestHash commits to them, without the raw `data` (its
 *   `dataHash` instead), plus the block the request was made in and its `selector`. The spend
 *   collector reads past approvals back through `parseApprovalParts`, so this object must round-trip
 *   through it: `block`, `agentId`, `value` and `deadline` as decimal strings, `chainId` a JSON
 *   number, `selector` 4 bytes or `null`.
 * - `params`: four of `mandate-v1`'s constants (`permissionWindowBlocks`, `spendWindowSeconds`,
 *   `maxDeadlineAheadSeconds`, `simulationGas`) and three of the contracts it read (the Identity
 *   Registry, the forwarder, the MandateRegistry). Not everything is recorded: `consumedCallGas` and
 *   the ValidationRegistry's address are fixed by the tag and the SDK's `DEPLOYMENTS` instead.
 * - `mandate`: the record at `P` and the agent's `currentOwner` there, or `null` when there is none.
 * - `spend`: `{ since, total, entries }`, `{ unreadable }`, or `null` when there is no mandate.
 * - `permissions`: the permission window `[fromBlock, toBlock]` and its events.
 * - `simulation`: the action simulated at `P`.
 *
 * `selector` is {@link selectorOf}`(data)`: the selector the rules compared with the allowlist,
 * `0x00000000` for empty data, and `null` when the data holds no selector an allowlist can match
 * (1-3 bytes, or non-empty data starting with `0x00000000`). Never the raw first bytes, which for 1-3
 * bytes of data wouldn't be a 4-byte value.
 *
 * **This format is frozen.** Recorded verdicts must keep verifying, so no key may be added, removed
 * or renamed, and no value's encoding may change, without a new tag.
 *
 * Built field by field, so the document's shape never depends on what else a reader returned.
 * Addresses are EIP-55 and hashes lower-case, so the bytes don't depend on the input's letter case.
 * Integers stay `bigint`; `canonicalJson` writes them as decimal strings.
 */
export function mandateEvidence(inputs: MandateInputs, addresses: MandateAddresses): Record<string, unknown> {
  const { pinned, owner, request, mandate, spend, permissions, simulation } = inputs;
  return {
    block: { number: pinned.number, hash: lower(pinned.hash), timestamp: pinned.timestamp },
    request: requestEvidence(request),
    params: {
      permissionWindowBlocks: MANDATE_V1.permissionWindowBlocks,
      spendWindowSeconds: MANDATE_V1.spendWindowSeconds,
      maxDeadlineAheadSeconds: MANDATE_V1.maxDeadlineAheadSeconds,
      simulationGas: MANDATE_V1.simulationGas,
      identityRegistry: getAddress(addresses.identityRegistry),
      agentRequestForwarder: getAddress(addresses.forwarder),
      mandateRegistry: getAddress(addresses.mandateRegistry),
    },
    mandate:
      mandate === null
        ? null
        : {
            allowedTargets: mandate.allowedTargets.map((target) => getAddress(target)),
            allowedSelectors: mandate.allowedSelectors.map(lower),
            maxValuePerTx: mandate.maxValuePerTx,
            maxValuePerDay: mandate.maxValuePerDay,
            validUntil: mandate.validUntil,
            mandateHash: lower(mandate.mandateHash),
            owner: getAddress(mandate.owner),
            setAtBlock: mandate.setAtBlock,
            currentOwner: getAddress(owner),
          },
    spend:
      spend === null
        ? null
        : "unreadable" in spend
          ? { unreadable: spend.unreadable }
          : {
              since: spend.since,
              total: spend.total,
              entries: spend.entries.map((entry) => ({
                requestHash: lower(entry.requestHash),
                approvedAt: entry.approvedAt,
                gate: getAddress(entry.gate),
                value: entry.value,
                deadline: entry.deadline,
                consumed: entry.consumed,
                counted: entry.counted,
              })),
            },
    permissions: {
      fromBlock: permissions.fromBlock,
      toBlock: permissions.toBlock,
      events: permissions.events.map((event) => ({
        block: event.block,
        logIndex: event.logIndex,
        txHash: lower(event.txHash),
        emitter: event.emitter,
        event: event.event,
        afterMandate: event.afterMandate,
      })),
    },
    simulation: simulation.ok
      ? { ok: true }
      : { ok: false, error: simulation.error, revertSelector: simulation.revertSelector === null ? null : lower(simulation.revertSelector) },
  };
}

/** The evidence's `request` object: the action as its `requestHash` commits to it (see {@link mandateEvidence}). */
export interface EvidenceRequest {
  block: bigint;
  chainId: number;
  gate: Address;
  agentId: bigint;
  target: Address;
  value: bigint;
  dataHash: Hex;
  selector: Hex | null;
  deadline: bigint;
  salt: Hex;
}

/**
 * The `request` object of a `mandate-v1` evidence document (see {@link mandateEvidence}): the
 * request's block and committed fields, `dataHash` instead of the raw `data`, and its `selector`.
 * Exported so `risk-v1`'s evidence carries exactly the same object, built by the same code.
 */
export function requestEvidence(request: MandateInputs["request"]): EvidenceRequest {
  return {
    block: request.block,
    chainId: request.chainId,
    gate: getAddress(request.gate),
    agentId: request.agentId,
    target: getAddress(request.target),
    value: request.value,
    dataHash: keccak256(request.data),
    selector: selectorOf(request.data),
    deadline: request.deadline,
    salt: lower(request.salt),
  };
}

function lower(hex: Hex): Hex {
  return hex.toLowerCase() as Hex;
}
