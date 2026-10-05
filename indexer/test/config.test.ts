import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbiItem, toEventSelector, type Abi, type AbiEvent } from "viem";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DEPLOYMENTS,
  agentRequestForwarderAbi,
  attestGateAbi,
  findingsBoardAbi,
  identityRegistryAbi,
  mandateRegistryAbi,
  validationRegistryAbi,
} from "../../packages/sdk/src/index.ts";
import { MANDATE_EPOCHS } from "../src/lib/epochs.ts";

// config.yaml is the indexer's only copy of our addresses and deploy blocks: these tests hold it to the SDK's
// DEPLOYMENTS and to docs/deployments.md, and its event signatures to the SDK's ABIs (the handlers read the
// parameters by name). package.json is held to what Envio Cloud can build: it uploads this folder alone, ignores the
// lockfile and builds with pnpm 10.32 on Node 24 (plan decision 5, addition 3).

const INDEXER = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(INDEXER, path), "utf8");

interface ContractDef {
  name: string;
  events: { event: string }[];
}
interface ChainContract {
  name: string;
  address: string | string[];
  start_block: number;
}
interface Config {
  address_format: string;
  contracts: ContractDef[];
  chains: { id: number; start_block: number; contracts: ChainContract[] }[];
}

const config = parse(read("config.yaml")) as Config;
const chain = config.chains[0];
const testnet = DEPLOYMENTS[10143];
const deploymentsDoc = read("../docs/deployments.md");

/** The block 10,675,492 is the canonical Identity Registry's first Transfer/Approval/ApprovalForAll, from HyperSync (5 Oct 2026). */
const IDENTITY_REGISTRY_FIRST_EVENT_BLOCK = 10_675_492;

const contract = (name: string) => {
  const found = chain?.contracts.find((c) => c.name === name);
  if (!found) throw new Error(`config.yaml has no ${name} on chain 10143`);
  return found;
};
const addresses = (name: string) => [contract(name).address].flat().map((a) => a.toLowerCase());

/** The "(block N)" docs/deployments.md records in the table row for `address`. */
function documentedDeployBlock(address: string): number {
  const row = deploymentsDoc.split("\n").find((line) => line.startsWith("| Monad testnet") && line.toLowerCase().includes(`/address/${address.toLowerCase()})`));
  const block = row?.match(/\(block ([\d,]+)\)/)?.[1];
  if (!block) throw new Error(`docs/deployments.md has no deploy block for ${address}`);
  return Number(block.replaceAll(",", ""));
}

describe("config.yaml", () => {
  it("indexes one chain, Monad testnet, with lowercase addresses", () => {
    expect(config.chains).toHaveLength(1);
    expect(chain?.id).toBe(10143);
    expect(config.address_format).toBe("lowercase");
  });

  it("names every contract we deployed at the SDK's address", () => {
    expect(addresses("ValidationRegistry")).toEqual([testnet.validationRegistry.toLowerCase()]);
    expect(addresses("AgentRequestForwarder")).toEqual([testnet.agentRequestForwarder.toLowerCase()]);
    expect(addresses("MandateRegistryV1")).toEqual([testnet.mandateRegistries[0]?.address.toLowerCase()]);
    expect(addresses("MandateRegistryV2")).toEqual([testnet.mandateRegistries[1]?.address.toLowerCase()]);
    expect(testnet.mandateRegistries).toHaveLength(2);
    expect(addresses("FindingsBoard")).toEqual([testnet.findingsBoard.address.toLowerCase()]);
    expect(addresses("DemoAgentVault")).toEqual([testnet.demoAgentVaultP2, testnet.demoAgentVaultP3, testnet.demoAgentVault].map((a) => a.toLowerCase()));
    expect(addresses("IdentityRegistry")).toEqual([testnet.identityRegistry.toLowerCase()]);
  });

  it("starts each contract at its deploy block, as docs/deployments.md and the SDK record it", () => {
    for (const name of ["ValidationRegistry", "AgentRequestForwarder", "MandateRegistryV1", "MandateRegistryV2", "FindingsBoard"]) {
      expect(contract(name).start_block, name).toBe(documentedDeployBlock(addresses(name)[0] as string));
    }
    expect(contract("DemoAgentVault").start_block).toBe(Math.min(...addresses("DemoAgentVault").map(documentedDeployBlock)));
    expect(BigInt(contract("ValidationRegistry").start_block)).toBe(testnet.validationRegistryDeployBlock);
    expect(BigInt(contract("MandateRegistryV1").start_block)).toBe(testnet.mandateRegistries[0]?.fromBlock);
    expect(BigInt(contract("MandateRegistryV2").start_block)).toBe(testnet.mandateRegistries[1]?.fromBlock);
    expect(BigInt(contract("FindingsBoard").start_block)).toBe(testnet.findingsBoard.fromBlock);
    expect(contract("IdentityRegistry").start_block).toBe(IDENTITY_REGISTRY_FIRST_EVENT_BLOCK);
    expect(chain?.start_block).toBe(Math.min(...(chain?.contracts ?? []).map((c) => c.start_block)));
  });

  it("uses the same MandateRegistry epochs as the handlers", () => {
    expect(MANDATE_EPOCHS.map((e) => ({ registry: e.registry, fromBlock: e.fromBlock }))).toEqual(
      testnet.mandateRegistries.map((r) => ({ registry: r.address.toLowerCase(), fromBlock: r.fromBlock })),
    );
  });

  it("declares each event exactly as the SDK's ABI does: names, types and indexed flags", () => {
    const abis: Record<string, Abi> = {
      ValidationRegistry: validationRegistryAbi,
      MandateRegistryV1: mandateRegistryAbi,
      MandateRegistryV2: mandateRegistryAbi,
      AgentRequestForwarder: agentRequestForwarderAbi,
      FindingsBoard: findingsBoardAbi,
      DemoAgentVault: attestGateAbi,
      IdentityRegistry: identityRegistryAbi,
    };
    expect(config.contracts.map((c) => c.name).sort()).toEqual(Object.keys(abis).sort());
    for (const def of config.contracts) {
      for (const { event } of def.events) {
        const parsed = parseAbiItem(`event ${event}`) as AbiEvent;
        const sdk = (abis[def.name] ?? []).find((item): item is AbiEvent => item.type === "event" && item.name === parsed.name);
        expect(sdk, `${def.name}.${parsed.name}`).toBeDefined();
        expect(toEventSelector(parsed), `${def.name}.${parsed.name}`).toBe(toEventSelector(sdk as AbiEvent));
        expect(parsed.inputs, `${def.name}.${parsed.name}`).toEqual(sdk?.inputs);
      }
    }
  });
});

describe("package.json, for Envio Cloud", () => {
  const pkg = JSON.parse(read("package.json")) as {
    packageManager?: string;
    engines?: { node?: string };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    pnpm?: unknown;
  };

  it("pins every dependency to an exact version (Cloud ignores the lockfile; no workspace: or catalog:)", () => {
    const versions = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(versions.length).toBeGreaterThan(0);
    for (const [name, version] of versions) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies?.envio).toBe("3.12.1");
  });

  it("declares no package manager and no pnpm settings, and admits Node 22 and 24", () => {
    expect(pkg.packageManager).toBeUndefined();
    expect(pkg.pnpm).toBeUndefined();
    expect(pkg.engines?.node).toBe(">=22");
  });
});

describe("handler sources", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sourceFiles(path) : /\.ts$/.test(name) ? [path] : [];
    });
  }

  it("import nothing from outside indexer/ (Cloud uploads only this folder)", () => {
    const files = sourceFiles(join(INDEXER, "src"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const [, spec] of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        if (!spec?.startsWith(".")) continue;
        const target = resolve(dirname(file), spec);
        expect(relative(INDEXER, target).startsWith(".."), `${relative(INDEXER, file)} imports ${spec}`).toBe(false);
      }
    }
  });
});
