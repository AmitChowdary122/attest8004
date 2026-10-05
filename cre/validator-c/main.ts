// Validator C's CRE workflow (P11, docs/cre.md). The polyfill comes first: CRE's QuickJS lacks atob/btoa.
import "./src/polyfills.ts";
import { Runner } from "@chainlink/cre-sdk";
import { workflowConfigSchema } from "./src/config.ts";
import { initWorkflow } from "./src/workflow.ts";

export async function main() {
  const runner = await Runner.newRunner({ configSchema: workflowConfigSchema });
  await runner.run(initWorkflow);
}

main();
