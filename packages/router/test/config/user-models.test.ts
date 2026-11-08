import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli.js";
import {
  loadEffectiveCatalog,
  loadModelCatalog,
  mergeUserModels,
  unknownEnabledModels,
} from "../../src/catalog/model-catalog.js";
import { collectUsageChain } from "../../src/collectors/collector-chain.js";
import { collectorsForAccount } from "../../src/collectors/registry.js";
import { executeRun } from "../../src/commands/run.js";
import { loadConfig } from "../../src/config/config-loader.js";
import { buildAgentCommand } from "../../src/launch/agent-command.js";
import { evaluateEligibility } from "../../src/policy/eligibility.js";
import { AccountSchema } from "../../src/domain/account.js";
import { fakeTypeSafe } from "../cli/fixtures.js";

const examplePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/examples/opencode-go.config.json",
);
const example = JSON.parse(readFileSync(examplePath, "utf8")) as {
  accounts: Array<Record<string, unknown>>;
  models: Array<Record<string, unknown>>;
};
const kimi = example.models[0]!;

function homeWithConfig(config: unknown): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "router-user-models-"));
  writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
  return home;
}

async function runAccounts(home: string): Promise<{ out: string; err: string; code: number }> {
  let out = "";
  let err = "";
  const program = createProgram({
    stdout: { write: (chunk: string) => ((out += chunk), true) },
    stderr: { write: (chunk: string) => ((err += chunk), true) },
    env: { MODEL_ROUTER_HOME: home },
  });
  program.exitOverride();
  await program.parseAsync(["node", "router", "accounts"]);
  return { out, err, code: program.exitCode ?? 0 };
}

describe("user-declared models", () => {
  it("parses the documented OpenCode Go example and adds it to the catalog", () => {
    const config = loadConfig({ env: { MODEL_ROUTER_HOME: homeWithConfig(example) } });
    expect(config.models.map((model) => model.id)).toEqual(["opencode-go:kimi-k3.1-pro"]);
    const catalog = loadEffectiveCatalog(config.models);
    const builtIn = loadModelCatalog();
    expect(catalog.models).toHaveLength(builtIn.models.length + 1);
    expect(unknownEnabledModels(catalog, config.accounts)).toEqual([]);
  });

  it("defaults to no extra models when the key is absent", () => {
    const config = loadConfig({ env: { MODEL_ROUTER_HOME: homeWithConfig({ accounts: [] }) } });
    expect(config.models).toEqual([]);
    expect(loadEffectiveCatalog(config.models).models).toEqual(loadModelCatalog().models);
  });

  it("validates user models with the catalog schema", () => {
    const home = homeWithConfig({ models: [{ ...kimi, supportedEfforts: ["turbo"] }] });
    expect(() => loadConfig({ env: { MODEL_ROUTER_HOME: home } })).toThrow(/supportedEfforts/);
  });

  it("rejects a user model that reuses a built-in id", () => {
    const config = loadConfig({
      env: {
        MODEL_ROUTER_HOME: homeWithConfig({ models: [{ ...kimi, id: "openai:opencode" }] }),
      },
    });
    expect(() => mergeUserModels(loadModelCatalog(), config.models)).toThrow(
      /models\[0\] id "openai:opencode" is already a built-in model/,
    );
  });

  it("rejects the same user model id twice", () => {
    const config = loadConfig({
      env: { MODEL_ROUTER_HOME: homeWithConfig({ models: [kimi, kimi] }) },
    });
    expect(() => mergeUserModels(loadModelCatalog(), config.models)).toThrow(
      /models\[1\] id "opencode-go:kimi-k3.1-pro" is listed more than once/,
    );
  });

  it("launches OpenCode with the provider/model launch name and no effort flag", () => {
    expect(
      buildAgentCommand({
        agent: "opencode",
        launchName: "opencode-go/kimi-k3.1-pro",
        effort: "none",
      }),
    ).toEqual(["opencode", "mini", "--model", "opencode-go/kimi-k3.1-pro"]);
  });
});

describe("router accounts with user models", () => {
  it("passes the documented example without warnings", async () => {
    const result = await runAccounts(homeWithConfig(example));
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/acct_opencode_go/);
    expect(result.err).toBe("");
  });

  it("fails on an id clash with the built-in catalog", async () => {
    const result = await runAccounts(
      homeWithConfig({ ...example, models: [{ ...kimi, id: "openai:opencode" }] }),
    );
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/already a built-in model/);
  });

  it("warns about an enabled model id that nothing defines", async () => {
    const result = await runAccounts(homeWithConfig({ accounts: example.accounts }));
    expect(result.code).toBe(0);
    expect(result.err).toMatch(
      /acct_opencode_go enables "opencode-go:kimi-k3.1-pro", which no built-in or config.json model defines/,
    );
  });
});

describe("OpenCode Go quota", () => {
  const personalGo = AccountSchema.parse(example.accounts[0]);
  const sharedGo = AccountSchema.parse({ ...example.accounts[0], ownership: "shared" });
  const model = loadEffectiveCatalog(
    loadConfig({
      env: { MODEL_ROUTER_HOME: homeWithConfig(example) },
    }).models,
  ).models.find((item) => item.id === "opencode-go:kimi-k3.1-pro")!;

  it("reports unknown, fresh usage instead of an error", async () => {
    const usage = await collectUsageChain(personalGo, collectorsForAccount(personalGo));
    expect(usage.certainty).toBe("unknown");
    expect(usage.source).toBe("none");
    expect(Date.parse(usage.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("keeps a personal account eligible at full projected quota, and excludes a shared one", async () => {
    const usage = await collectUsageChain(personalGo, collectorsForAccount(personalGo));
    const at = new Date(usage.collectedAt);
    expect(
      evaluateEligibility({ account: personalGo, model, usage, estimatedCostRatio: 0.05, now: at }),
    ).toEqual({ eligible: true, projectedRemainingRatio: 1 });
    expect(
      evaluateEligibility({ account: sharedGo, model, usage, estimatedCostRatio: 0.05, now: at }),
    ).toEqual({ eligible: false, reason: "unknown-usage" });
  });

  it("dry-runs a route to Kimi on OpenCode", async () => {
    const usage = await collectUsageChain(personalGo, collectorsForAccount(personalGo));
    const result = await executeRun(
      "List the files in the repository root.",
      { dryRun: true },
      {
        accounts: [personalGo],
        models: [model],
        usage: { [personalGo.id]: usage },
        client: fakeTypeSafe({ family: "implementation", phase: "implementation", effort: "none" }),
        env: {},
        now: new Date(usage.collectedAt),
      },
    );
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/opencode mini --model opencode-go\/kimi-k3\.1-pro/);
    expect(result.output).toMatch(/unknown \(no collector returned usage\)/);
  });
});
