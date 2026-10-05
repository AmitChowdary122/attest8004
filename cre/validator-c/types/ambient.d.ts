// The workflow compiles with `types: []`. This file gives tsc the CRE QuickJS runtime's globals (console, TextEncoder/
// TextDecoder, atob/btoa: the CRE SDK's own declarations), plus `crypto`, which packages/sdk/src/action.ts's buildAction
// reads. The workflow never calls buildAction, and CRE's runtime has no `crypto`. Only tsconfig.json includes this
// file; the tests get both from Bun's types.
import type {} from "@chainlink/cre-sdk";

declare global {
  const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };
}

export {};
