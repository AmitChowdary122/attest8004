import {
  buildEvidence,
  canonicalJson,
  computeRequestHashFromParts,
  decodeJsonDataUri,
  DEPLOYMENTS,
  encodeCanonicalJsonDataUri,
} from "@attest8004/sdk";
import { getAddress, keccak256, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { parseApprovalParts } from "../src/collect.ts";
import { mandateEvidence, requestEvidence } from "../src/evidence.ts";
import { MANDATE_V1 } from "../src/params.ts";
import type { MandateAddresses } from "../src/reader.ts";
import type { MandateInputs, PinnedBlock } from "../src/types.ts";

const VALIDATOR = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const GATE = getAddress("0x23bfbd12545ccd1501dda1b65a54518fd6212a96");
const OWNER = getAddress("0x3efeb3cf2fb54a7d99abe90aab786ce5a831a8cf");
const NEW_OWNER = getAddress("0x00000000000000000000000000000000000000a1");
const TARGET = getAddress("0x00000000000000000000000000000000000000b2");
const AGENT = 1_984n;
const CHAIN_ID = 10_143;
const P: PinnedBlock = { number: 70_000_000n, hash: keccak256(toHex("block P")), timestamp: 1_790_000_000n };

const deployment = DEPLOYMENTS[10143];
const ADDRESSES: MandateAddresses = {
  validationRegistry: deployment.validationRegistry,
  identityRegistry: deployment.identityRegistry,
  forwarder: deployment.agentRequestForwarder,
  mandateRegistry: deployment.mandateRegistries[0].address,
};

function inputs(over: { value?: bigint; data?: Hex; salt?: Hex; agentId?: bigint } & Partial<MandateInputs> = {}): MandateInputs {
  const { value = 1_000n, data = "0x", salt = keccak256(toHex("salt")), agentId = AGENT, ...rest } = over;
  const parts = {
    chainId: CHAIN_ID,
    gate: GATE,
    agentId,
    target: TARGET,
    value,
    dataHash: keccak256(data),
    deadline: P.timestamp + 600n,
    salt,
  };
  return {
    pinned: P,
    owner: OWNER,
    request: {
      block: P.number - 3n,
      requestHash: computeRequestHashFromParts({ ...parts, validator: VALIDATOR }),
      chainId: CHAIN_ID,
      gate: GATE,
      agentId,
      target: TARGET,
      value,
      data,
      deadline: parts.deadline,
      salt,
    },
    mandate: {
      allowedTargets: [TARGET, OWNER],
      allowedSelectors: [MANDATE_V1.plainTransferSelector, "0xa9059cbb"],
      maxValuePerTx: 2_000n,
      maxValuePerDay: 5_000n,
      validUntil: P.timestamp + 86_400n,
      mandateHash: keccak256(toHex("mandate")),
      owner: OWNER,
      setAtBlock: P.number - 10_000n,
    },
    spend: {
      since: P.timestamp - MANDATE_V1.spendWindowSeconds,
      total: 700n,
      entries: [
        {
          requestHash: keccak256(toHex("earlier approval")),
          approvedAt: P.timestamp - 3_600n,
          gate: GATE,
          value: 700n,
          deadline: P.timestamp - 3_000n,
          consumed: true,
          counted: true,
        },
        {
          requestHash: keccak256(toHex("expired approval")),
          approvedAt: P.timestamp - 7_200n,
          gate: GATE,
          value: 900n,
          deadline: P.timestamp - 6_600n,
          consumed: false,
          counted: false,
        },
      ],
    },
    permissions: {
      fromBlock: P.number - MANDATE_V1.permissionWindowBlocks + 1n,
      toBlock: P.number,
      events: [
        {
          block: P.number - 20n,
          logIndex: 3,
          txHash: keccak256(toHex("approval tx")),
          emitter: "IdentityRegistry",
          event: "Approval",
          afterMandate: true,
        },
      ],
    },
    simulation: { ok: true },
    ...rest,
  };
}

/** The whole evidence document the validator base would post for `i`, as canonical JSON text. */
function postedText(i: MandateInputs, score = 100, reasons: string[] = []): string {
  const doc = buildEvidence({ tag: MANDATE_V1.tag, requestHash: i.request.requestHash, result: { score, reasons, evidence: mandateEvidence(i, ADDRESSES) } });
  const { uri } = encodeCanonicalJsonDataUri(doc);
  const decoded = decodeJsonDataUri(uri);
  if (!decoded.ok) throw new Error(decoded.detail);
  return decoded.text;
}

describe("mandateEvidence", () => {
  it("has exactly the documented top-level keys, none of them the base's reserved keys", () => {
    const evidence = mandateEvidence(inputs(), ADDRESSES);
    expect(Object.keys(evidence).sort()).toEqual(["block", "mandate", "params", "permissions", "request", "simulation", "spend"]);
    for (const reserved of ["schema", "validator", "requestHash", "score", "reasons"]) expect(evidence).not.toHaveProperty(reserved);
  });

  it("records P, the request without raw data, the constants and the addresses, with every bigint as a decimal string", () => {
    const i = inputs({ data: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001" });
    const doc = JSON.parse(canonicalJson(mandateEvidence(i, ADDRESSES))) as Record<string, Record<string, unknown>>;

    expect(doc.block).toEqual({ number: "70000000", hash: P.hash, timestamp: "1790000000" });
    expect(doc.request).toEqual({
      block: "69999997",
      chainId: 10143,
      gate: GATE,
      agentId: "1984",
      target: TARGET,
      value: "1000",
      dataHash: keccak256(i.request.data),
      selector: "0xa9059cbb",
      deadline: (P.timestamp + 600n).toString(),
      salt: i.request.salt,
    });
    expect(doc.request).not.toHaveProperty("data");
    expect(doc.params).toEqual({
      permissionWindowBlocks: "6000",
      spendWindowSeconds: "90000",
      maxDeadlineAheadSeconds: "3600",
      simulationGas: "1000000",
      identityRegistry: deployment.identityRegistry,
      agentRequestForwarder: deployment.agentRequestForwarder,
      mandateRegistry: deployment.mandateRegistries[0].address,
    });
    expect(doc.mandate).toEqual({
      allowedTargets: [TARGET, OWNER],
      allowedSelectors: ["0x00000000", "0xa9059cbb"],
      maxValuePerTx: "2000",
      maxValuePerDay: "5000",
      validUntil: (P.timestamp + 86_400n).toString(),
      mandateHash: keccak256(toHex("mandate")),
      owner: OWNER,
      setAtBlock: "69990000",
      currentOwner: OWNER,
    });
    expect(doc.spend).toEqual({
      since: (P.timestamp - 90_000n).toString(),
      total: "700",
      entries: [
        {
          requestHash: keccak256(toHex("earlier approval")),
          approvedAt: (P.timestamp - 3_600n).toString(),
          gate: GATE,
          value: "700",
          deadline: (P.timestamp - 3_000n).toString(),
          consumed: true,
          counted: true,
        },
        {
          requestHash: keccak256(toHex("expired approval")),
          approvedAt: (P.timestamp - 7_200n).toString(),
          gate: GATE,
          value: "900",
          deadline: (P.timestamp - 6_600n).toString(),
          consumed: false,
          counted: false,
        },
      ],
    });
    expect(doc.permissions).toEqual({
      fromBlock: "69994001",
      toBlock: "70000000",
      events: [
        {
          block: "69999980",
          logIndex: 3,
          txHash: keccak256(toHex("approval tx")),
          emitter: "IdentityRegistry",
          event: "Approval",
          afterMandate: true,
        },
      ],
    });
    expect(doc.simulation).toEqual({ ok: true });
  });

  it("builds `request` with requestEvidence, exported so risk-v1's evidence carries the identical object", () => {
    const i = inputs({ data: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001" });
    const evidence = mandateEvidence(i, ADDRESSES) as { request: unknown };
    expect(canonicalJson(requestEvidence(i.request))).toBe(canonicalJson(evidence.request));
    // Letter case of the input never changes it.
    const lower = { ...i.request, gate: i.request.gate.toLowerCase() as Hex, target: i.request.target.toLowerCase() as Hex, salt: i.request.salt.toUpperCase().replace("0X", "0x") as Hex };
    expect(canonicalJson(requestEvidence(lower))).toBe(canonicalJson(evidence.request));
  });

  it("records the current owner next to the mandate's own, and null for a missing mandate and spend", () => {
    const stale = mandateEvidence(inputs({ owner: NEW_OWNER }), ADDRESSES) as { mandate: { owner: string; currentOwner: string } };
    expect(stale.mandate.owner).toBe(OWNER);
    expect(stale.mandate.currentOwner).toBe(NEW_OWNER);

    const none = mandateEvidence(inputs({ mandate: null, spend: null }), ADDRESSES);
    expect(none.mandate).toBeNull();
    expect(none.spend).toBeNull();
  });

  it("records the passkey permission events under their own names, from the MandateRegistry (same tag: only v2 emits them)", () => {
    const i = inputs();
    const passkeyEvent = (block: bigint, event: "PasskeySet" | "PasskeyRotated", afterMandate: boolean) => ({
      block,
      logIndex: 0,
      txHash: keccak256(toHex(`${event} tx`)),
      emitter: "MandateRegistry" as const,
      event,
      afterMandate,
    });
    const events = [passkeyEvent(P.number - 10_005n, "PasskeySet", false), passkeyEvent(P.number - 5n, "PasskeyRotated", true)];
    const doc = JSON.parse(canonicalJson(mandateEvidence(inputs({ permissions: { ...i.permissions, events } }), ADDRESSES))) as {
      permissions: { events: unknown[] };
    };
    expect(doc.permissions.events).toEqual([
      { block: (P.number - 10_005n).toString(), logIndex: 0, txHash: keccak256(toHex("PasskeySet tx")), emitter: "MandateRegistry", event: "PasskeySet", afterMandate: false },
      { block: (P.number - 5n).toString(), logIndex: 0, txHash: keccak256(toHex("PasskeyRotated tx")), emitter: "MandateRegistry", event: "PasskeyRotated", afterMandate: true },
    ]);
  });

  it("records unreadable spend and a failed simulation as they are", () => {
    const evidence = mandateEvidence(
      inputs({
        spend: { unreadable: "0xabc: evidence hash 0x1 is not the responseHash 0x2" },
        simulation: { ok: false, error: "REVERTED", revertSelector: "0x08c379a0" },
      }),
      ADDRESSES,
    );
    expect(evidence.spend).toEqual({ unreadable: "0xabc: evidence hash 0x1 is not the responseHash 0x2" });
    expect(evidence.simulation).toEqual({ ok: false, error: "REVERTED", revertSelector: "0x08c379a0" });
  });

  it.each([
    { name: "empty data: the plain-transfer selector", data: "0x" as Hex, selector: "0x00000000" },
    { name: "a call: its lower-case selector", data: "0xA9059CBB00" as Hex, selector: "0xa9059cbb" },
    { name: "1-3 bytes: no selector", data: "0xa905" as Hex, selector: null },
    { name: "non-empty data starting 0x00000000: no selector", data: "0x0000000001" as Hex, selector: null },
  ])("selector for $name", ({ data, selector }) => {
    const evidence = mandateEvidence(inputs({ data }), ADDRESSES) as { request: { selector: unknown } };
    expect(evidence.request.selector).toBe(selector);
  });

  it("is the same document whatever the case of the input addresses and hashes", () => {
    const i = inputs({ salt: keccak256(toHex("mixed")).toUpperCase().replace("0X", "0x") as Hex });
    const lower: MandateInputs = {
      ...i,
      owner: OWNER.toLowerCase() as Hex,
      request: { ...i.request, gate: GATE.toLowerCase() as Hex, target: TARGET.toLowerCase() as Hex },
    };
    expect(canonicalJson(mandateEvidence(lower, ADDRESSES))).toBe(canonicalJson(mandateEvidence(i, ADDRESSES)));
  });
});

describe("mandate-v1 evidence round trip", () => {
  // The spend collector reads past approvals back from their posted evidence: whatever this module
  // writes must parse strictly and recompute to the approval's own requestHash.
  it.each([
    { name: "a plain transfer", over: {} },
    { name: "a call with arguments", over: { data: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001" as Hex } },
    { name: "1-3 bytes of data (no selector)", over: { data: "0xa905" as Hex } },
    { name: "selector zero with arguments (no selector)", over: { data: "0x0000000001" as Hex } },
    { name: "a value above 2^53", over: { value: 2n ** 200n + 7n } },
    { name: "an agentId above 2^53", over: { agentId: 2n ** 70n } },
    { name: "a mixed-case salt", over: { salt: `0x${"Ab".repeat(32)}` as Hex } },
  ])("$name: parseApprovalParts recovers parts that hash to the requestHash", ({ over }) => {
    const i = inputs(over);
    const parsed = parseApprovalParts(postedText(i));
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.requestHash).toBe(i.request.requestHash.toLowerCase());
    expect(computeRequestHashFromParts({ ...parsed.parts, validator: VALIDATOR })).toBe(i.request.requestHash);
    expect(parsed.parts.value).toBe(i.request.value);
    expect(parsed.parts.agentId).toBe(i.request.agentId);
  });

  it("round-trips a rejected verdict's evidence too (missing mandate, unreadable spend)", () => {
    const i = inputs({ mandate: null, spend: null });
    const parsed = parseApprovalParts(postedText(i, 0, ["MANDATE_MISSING"]));
    if ("error" in parsed) throw new Error(parsed.error);
    expect(computeRequestHashFromParts({ ...parsed.parts, validator: VALIDATOR })).toBe(i.request.requestHash);
  });
});
