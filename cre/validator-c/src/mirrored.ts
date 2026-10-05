// Repo constants the workflow can't import without pulling Node-only code into CRE's WASM (packages/sdk/src/
// validator.ts uses setTimeout, which CRE's runtime refuses). scripts/src/cre-config.test.ts pins each to its source.

/** packages/sdk/src/validator.ts EVIDENCE_SCHEMA_V1: the `schema` of every evidence document. */
export const EVIDENCE_SCHEMA_V1 = "attest8004.evidence.v1";
