import { ValidatorBase, type CheckResult, type VerifiedRequest } from "@attest8004/sdk";

/** The tag on the stub's responses: deliberately not `mandate-v1`, because no checks run. */
export const STUB_TAG = "attest8004-e2e-stub";

/**
 * A validator built on the SDK's `ValidatorBase` that passes every request the base class accepts.
 * The base still does all of its work: polling, the data: URI and hash checks, the agent, chain and
 * deadline checks, the status check before posting, and the explicit-gas response. Only `check()`
 * is a stub, and the evidence says so. For the end-to-end smoke test; never for a real gate.
 */
export class StubValidator extends ValidatorBase {
  protected override async check(_request: VerifiedRequest): Promise<CheckResult> {
    return {
      score: 100,
      reasons: ["STUB_NO_CHECKS"],
      evidence: {
        note: "P3 end-to-end smoke test of the SDK and validator base. No mandate or risk checks were run; this is not a validation verdict.",
      },
    };
  }
}
