/**
 * End-to-end coverage for AIR plugin support.
 *
 * Each test plants a real AIR catalog (`e2e/fixtures/air`) in the run's working
 * directory, then drives the real pinned Pi binary against the simulated LLM. The
 * question these answer is the one the repo exists for: does Pi — which has no
 * concept of an AIR plugin — actually load and act on one?
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AIR_FIXTURE_DIR,
  type PiRunResult,
  PLUGINS_EXTENSION,
  PLUGINS_PACKAGE_DIR,
  runPi,
  toolResults,
} from "../harness/pi.ts";

function expectCleanRun(result: PiRunResult): void {
  expect(result.exitCode, `pi exited ${result.exitCode}\nSTDERR:\n${result.stderr}`).toBe(0);
  expect(result.eventsOfType("agent_end").length).toBeGreaterThan(0);
}

/** Run Pi with the plugins extension and the AIR fixture catalog in place. */
function runWithAir(overrides: Partial<Parameters<typeof runPi>[0]> = {}) {
  return runPi({
    script: [{ type: "text", text: "ok" }],
    prompt: "hello",
    extensions: [PLUGINS_EXTENSION],
    fixtureDir: AIR_FIXTURE_DIR,
    ...overrides,
  } as Parameters<typeof runPi>[0]);
}

describe("plugin resolution inside a real Pi run", () => {
  it("discovers air.json and activates the plugin its catalog declares", async () => {
    const result = await runWithAir();
    expectCleanRun(result);
    expect(result.stderr).toContain("[pi-plugins] activated 1 plugin(s): @local/code-quality");
    // Resolved through the externalized .plugin/plugin.json manifest, not inline.
    expect(result.stderr).toContain("1 skill path(s), 1 hook(s), 1 MCP server(s) reported");
  });

  it("does nothing, quietly, when there is no AIR config", async () => {
    const result = await runPi({
      script: [{ type: "text", text: "ok" }],
      prompt: "hello",
      extensions: [PLUGINS_EXTENSION],
    });
    expectCleanRun(result);
    expect(result.stderr).toContain("[pi-plugins] no AIR plugins activated");
  });
});

describe("bundled skills", () => {
  it("reaches the model through Pi's own skill loading", async () => {
    const result = await runWithAir();
    expectCleanRun(result);
    // The strongest available proof: Pi put the plugin's skill in the system prompt
    // it sent upstream, so the simulated model's request payload carries the marker.
    const payload = JSON.stringify(result.llm.requests);
    expect(payload).toContain("repo-conventions");
    expect(result.stderr).toContain("[pi-plugins] contributing skill paths");
  });
});

describe("bundled hooks", () => {
  it("translates an AIR HOOK.json into a live pi-hooks hook that blocks a tool call", async () => {
    const result = await runWithAir({
      script: [
        { type: "tool", tool: "bash", args: { command: "./scripts/deploy.sh production" } },
        { type: "text", text: "understood" },
      ],
      prompt: "ship it",
    });
    expectCleanRun(result);
    const [call] = toolResults(result);
    expect(call?.isError).toBe(true);
    // The reason came out of the AIR hook's own script, via its non-zero exit.
    expect(call?.text).toContain("direct production deploys go through the release skill");
    expect(result.stderr).toContain("[pi-plugins] blocked bash");
  });

  it("honours the AIR matcher rather than firing on every tool call", async () => {
    const result = await runWithAir({
      script: [
        { type: "tool", tool: "bash", args: { command: "./scripts/deploy.sh staging" } },
        { type: "text", text: "done" },
      ],
      prompt: "ship it to staging",
    });
    expectCleanRun(result);
    expect(result.stderr).not.toContain("[pi-plugins] blocked");
  });
});

describe("MCP boundary", () => {
  it("reports a bundled MCP server without starting it", async () => {
    // Pi's MCP support comes from nicobailon/pi-mcp-adapter; re-implementing MCP
    // here is out of scope, so the adapter resolves the entry and stops there.
    const result = await runWithAir({ args: ["--tools", "read,bash"] });
    expectCleanRun(result);
    expect(result.stderr).toContain("1 MCP server(s) reported");
    // Nothing was spawned and no MCP tool was registered.
    expect(result.stderr).not.toContain("eslint-mcp-server");
    const toolNames = JSON.stringify(result.llm.requests);
    expect(toolNames).not.toContain("eslint-server");
  });
});

describe("packaging", () => {
  it("declares both the adapter and the bundled hooks engine in its pi manifest", () => {
    const manifest = JSON.parse(
      readFileSync(join(PLUGINS_PACKAGE_DIR, "package.json"), "utf8"),
    ) as { pi: { extensions: string[] }; bundledDependencies: string[] };
    expect(manifest.pi.extensions).toEqual([
      "./extensions/plugins.ts",
      "node_modules/@tadasant/pi-hooks/extensions/hooks.ts",
    ]);
    expect(manifest.bundledDependencies).toContain("@tadasant/pi-hooks");
  });

  it("loads as a pi package directory, the way `pi install` would", async () => {
    const result = await runWithAir({ extensions: [PLUGINS_PACKAGE_DIR] });
    expectCleanRun(result);
    expect(result.stderr).toContain("[pi-plugins] activated 1 plugin(s)");
    // The bundled hooks engine loaded alongside the adapter from the same package.
    expect(result.stderr).toContain("[pi-hooks] loaded");
  });
});
