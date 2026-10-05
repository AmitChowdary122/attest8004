import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TRUST_API_QUERIES } from "../../packages/sdk/src/trust-api.ts";

// The SDK's GraphQL documents (packages/sdk/src/trust-api.ts) against this schema: every entity and field the SDK
// selects or filters on must exist here, so a schema change can't silently break getAgentTrust, /dashboard or /inbox.

const schema = readFileSync(new URL("../schema.graphql", import.meta.url), "utf8");
const types = new Map<string, Set<string>>();
for (const [, name, body] of schema.matchAll(/^type (\w+)(?: @\w+)? \{([^}]*)\}/gm)) {
  types.set(name as string, new Set([...(body as string).matchAll(/^\s+(\w+):/gm)].map((m) => m[1] as string)));
}
const META_FIELDS = new Set(["chainId", "progressBlock", "isReady"]);

/** Each root selection of a document: its entity (aliases and _by_pk resolved), the fields it selects and filters on. */
function selections(document: string): { entity: string; fields: string[] }[] {
  const body = document.slice(document.indexOf("{") + 1, document.lastIndexOf("}"));
  const out: { entity: string; fields: string[] }[] = [];
  for (const m of body.matchAll(/(?:(\w+):\s*)?(\w+)\s*(\(([^)]*(?:\([^)]*\)[^)]*)*)\))?\s*\{([^{}]*)\}/g)) {
    const entity = (m[2] as string).replace(/_by_pk$/, "");
    const args = m[4] ?? "";
    const filtered = [...args.matchAll(/(\w+):\s*\{\s*_?\w+:/g)].map((a) => a[1] as string).filter((f) => !["where", "order_by"].includes(f));
    const ordered = [...args.matchAll(/order_by:\s*\{\s*(\w+):/g)].map((a) => a[1] as string);
    out.push({ entity, fields: [...(m[5] as string).split(/\s+/).filter(Boolean), ...filtered, ...ordered] });
  }
  return out;
}

describe("the SDK's trust API queries", () => {
  it("parse into root selections", () => {
    expect(selections(TRUST_API_QUERIES.agentTrust).map((s) => s.entity)).toEqual([
      "Agent",
      "AgentTrustSummary",
      "AgentTagSummary",
      "Mandate",
      "Passkey",
      "InboxKey",
      "ValidationRequest",
      "PermissionEvent",
      "_meta",
    ]);
  });

  for (const [name, document] of Object.entries(TRUST_API_QUERIES)) {
    it(`${name}: every entity and field exists in schema.graphql`, () => {
      for (const { entity, fields } of selections(document)) {
        const known = entity === "_meta" ? META_FIELDS : types.get(entity);
        expect(known, `${name}: entity ${entity}`).toBeDefined();
        for (const field of fields) expect(known?.has(field), `${name}: ${entity}.${field}`).toBe(true);
      }
    });
  }

  it("never asks for the internal TokenOwner", () => {
    for (const document of Object.values(TRUST_API_QUERIES)) expect(document).not.toMatch(/TokenOwner/);
  });
});
