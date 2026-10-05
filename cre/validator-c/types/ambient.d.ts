// packages/sdk/src/action.ts (imported for requestHash) has buildAction, which reads the global `crypto`. The
// workflow never calls it, and CRE's QuickJS runtime has no `crypto`, but the workflow compiles with `types: []`,
// so tsc needs the name declared. Only tsconfig.json includes this file; the tests get `crypto` from Bun's types.
declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };
