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
    expect(result.stderr).toContain("1 skill path(s), 1 hook(s), 1 MCP server(s)");
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

describe("MCP composition", () => {
  it("writes the bundled MCP server into the config pi-mcp-adapter reads", async () => {
    // This package does not speak MCP. Supporting a plugin's `mcp_servers` means
    // handing them to pi-mcp-adapter, which reads `.pi/mcp.json` when its own
    // factory loads — so the proof is that the file exists, with the right contents,
    // after a real Pi run.
    const result = await runWithAir();
    expectCleanRun(result);
    const config = JSON.parse(readFileSync(join(result.cwd, ".pi", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(config.mcpServers)).toEqual(["eslint-server"]);
    expect(config.mcpServers["eslint-server"]).toMatchObject({
      command: "npx",
      args: ["-y", "eslint-mcp-server"],
      // Provenance, so a later run can retract it when the plugin goes away.
      "x-pi-plugins": "@local/eslint-server",
    });
    expect(result.stderr).toContain("wrote MCP server(s) eslint-server");
  });

  it("says plainly when the required pi-mcp-adapter peer is not installed", async () => {
    // A silently half-activated plugin is the failure mode this guards against.
    const result = await runWithAir();
    expectCleanRun(result);
    expect(result.stderr).toContain("pi-mcp-adapter is NOT installed");
    expect(result.stderr).toContain("pi install npm:pi-mcp-adapter");
  });

  it("retracts a server it wrote for a plugin that is no longer active", async () => {
    // Plant an entry carrying this package's provenance marker for a plugin the
    // catalog no longer has. A real run must clean it up, or a removed plugin's
    // server would linger in the user's config forever.
    const result = await runWithAir({
      files: {
        ".pi/mcp.json": JSON.stringify(
          {
            mcpServers: {
              "gone-server": { command: "stale", "x-pi-plugins": "@local/gone-server" },
              mine: { command: "hand-written" },
            },
          },
          null,
          2,
        ),
      },
    });
    expectCleanRun(result);
    const config = JSON.parse(readFileSync(join(result.cwd, ".pi", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(config.mcpServers).not.toHaveProperty("gone-server");
    // The user's own entry is untouched.
    expect(config.mcpServers.mine?.command).toBe("hand-written");
    // And the currently-active plugin's server is present.
    expect(config.mcpServers["eslint-server"]?.command).toBe("npx");
  });

  it("never starts a server itself", async () => {
    const result = await runWithAir();
    expectCleanRun(result);
    // No MCP tool was registered and nothing was spawned by this package.
    expect(JSON.stringify(result.llm.requests)).not.toContain("eslint");
  });
});

describe("packaging", () => {
  it("declares both the adapter and the bundled hooks engine in its pi manifest", () => {
    const manifest = JSON.parse(
      readFileSync(join(PLUGINS_PACKAGE_DIR, "package.json"), "utf8"),
    ) as {
      pi: { extensions: string[] };
      bundledDependencies: string[];
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    expect(manifest.pi.extensions).toEqual([
      "./extensions/plugins.ts",
      "node_modules/@tadasant/pi-hooks/extensions/hooks.ts",
    ]);
    expect(manifest.bundledDependencies).toContain("@tadasant/pi-hooks");
    // pi-mcp-adapter is a required peer, not a bundled dependency: vendoring its
    // per-platform native keychain binaries would put a ~36 MB tarball on npm.
    expect(manifest.peerDependencies["pi-mcp-adapter"]).toBe(">=2.27.0");
    expect(manifest.dependencies).not.toHaveProperty("pi-mcp-adapter");
  });

  it("loads as a pi package directory, the way `pi install` would", async () => {
    const result = await runWithAir({ extensions: [PLUGINS_PACKAGE_DIR] });
    expectCleanRun(result);
    expect(result.stderr).toContain("[pi-plugins] activated 1 plugin(s)");
    // The bundled hooks engine loaded alongside the adapter from the same package.
    expect(result.stderr).toContain("[pi-hooks] loaded");
  });
});
