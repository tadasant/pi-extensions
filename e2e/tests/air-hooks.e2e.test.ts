/**
 * End-to-end: AIR hooks running inside a real Pi session.
 *
 * This is the format `@tadasant/pi-hooks` exists to run — a `hooks.json` index of
 * `HOOK.json` directories, exactly as https://github.com/pulsemcp/air defines it.
 * Each case plants a real AIR catalog, drives the pinned Pi binary against the
 * simulated LLM, and asserts on Pi's own event stream.
 *
 * The point these answer: a project whose *only* hooks configuration is an AIR
 * catalog gets working hooks, with no Pi-specific config file anywhere.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOOKS_PACKAGE_DIR, type PiRunResult, runPi, toolResults } from "../harness/pi.ts";

function expectCleanRun(result: PiRunResult): void {
  expect(result.exitCode, `pi exited ${result.exitCode}\nSTDERR:\n${result.stderr}`).toBe(0);
  expect(result.eventsOfType("agent_end").length).toBeGreaterThan(0);
}

/** See the FAQ in AGENTS.md: absence of the block line is the signal, not a tool error. */
function expectNotBlocked(result: PiRunResult): void {
  expect(result.stderr, `a hook blocked the call:\n${result.stderr}`).not.toContain(
    "[pi-hooks] blocked",
  );
}

/** An `air.json` naming the catalog this package ships. */
const BUILTIN_AIR_CONFIG = JSON.stringify(
  { name: "pi-e2e-builtin", catalogs: [join(HOOKS_PACKAGE_DIR, "air")] },
  null,
  2,
);

/** A hand-written AIR hook: index entry + HOOK.json + a guard script. */
function customCatalog(hookJson: unknown, script: string): Record<string, string> {
  return {
    "air.json": JSON.stringify({ name: "custom", hooks: ["./hooks.json"] }, null, 2),
    "hooks.json": JSON.stringify(
      { "custom-guard": { description: "A hand-written AIR hook", path: "hooks/custom-guard" } },
      null,
      2,
    ),
    "hooks/custom-guard/HOOK.json": JSON.stringify(hookJson, null, 2),
    "hooks/custom-guard/guard.mjs": script,
  };
}

describe("a project whose only hooks config is an AIR catalog", () => {
  it("loads the hooks and blocks a matching tool call", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "rm -rf /" } },
        { type: "text", text: "understood" },
      ],
      prompt: "clean up",
      files: { "air.json": BUILTIN_AIR_CONFIG },
    });
    expectCleanRun(result);
    // No .pi/hooks.json anywhere — the AIR index is the whole configuration.
    expect(result.stderr).toMatch(/\[pi-hooks\] loaded [1-9]\d* hook\(s\)/);
    const [call] = toolResults(result);
    expect(call?.isError).toBe(true);
    expect(call?.text).toContain("recursively delete a root");
  });

  it("leaves a command no AIR hook matches alone", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "rm -rf build/" } },
        { type: "text", text: "done" },
      ],
      prompt: "clean the build",
      files: { "air.json": BUILTIN_AIR_CONFIG },
    });
    expectCleanRun(result);
    expectNotBlocked(result);
  });

  it("blocks a write to a secret file, and exempts the example", async () => {
    const blocked = await runPi({
      script: [
        { type: "tool", tool: "write", args: { path: ".env", content: "TOKEN=leaked" } },
        { type: "text", text: "understood" },
      ],
      prompt: "write the env file",
      files: { "air.json": BUILTIN_AIR_CONFIG },
    });
    expectCleanRun(blocked);
    expect(toolResults(blocked)[0]?.isError).toBe(true);
    expect(toolResults(blocked)[0]?.text).toContain("edited by a human");

    const allowed = await runPi({
      script: [
        { type: "tool", tool: "write", args: { path: ".env.example", content: "TOKEN=" } },
        { type: "text", text: "done" },
      ],
      prompt: "write the example",
      files: { "air.json": BUILTIN_AIR_CONFIG },
    });
    expectCleanRun(allowed);
    expectNotBlocked(allowed);
  });
});

describe("a hand-written AIR hook", () => {
  it("runs its HOOK.json command and blocks on a non-zero exit", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "./deploy.sh production" } },
        { type: "text", text: "understood" },
      ],
      prompt: "ship it",
      files: customCatalog(
        {
          event: "pre_tool_call",
          matcher: "deploy",
          command: "node",
          args: ["./guard.mjs"],
          timeout_seconds: 10,
          "x-config": { environment: "production" },
        },
        [
          "const chunks = [];",
          "for await (const chunk of process.stdin) chunks.push(chunk);",
          "const event = JSON.parse(chunks.join('') || '{}');",
          "const cfg = JSON.parse(process.env.AIR_HOOK_CONFIG ?? '{}');",
          "console.error(`refused: ${event.input.command} targets ${cfg.environment}`);",
          "process.exit(1);",
        ].join("\n"),
      ),
    });
    expectCleanRun(result);
    const [call] = toolResults(result);
    expect(call?.isError).toBe(true);
    // The reason came from the hook's own script, and its x-config reached it.
    expect(call?.text).toContain("refused: ./deploy.sh production targets production");
  });

  it("honours the AIR matcher rather than firing on every tool call", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "./build.sh" } },
        { type: "text", text: "done" },
      ],
      prompt: "build it",
      files: customCatalog(
        { event: "pre_tool_call", matcher: "deploy", command: "node", args: ["./guard.mjs"] },
        "console.error('should not fire'); process.exit(1);",
      ),
    });
    expectCleanRun(result);
    expectNotBlocked(result);
  });

  it("receives the event on stdin and the AIR hook id in its environment", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "echo audited" } },
        { type: "text", text: "ok" },
      ],
      prompt: "run it",
      files: customCatalog(
        { event: "pre_tool_call", command: "node", args: ["./guard.mjs"] },
        [
          "import { writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const chunks = [];",
          "for await (const chunk of process.stdin) chunks.push(chunk);",
          "const event = JSON.parse(chunks.join('') || '{}');",
          // PI_HOOK_CWD is the project directory; the guard itself runs from its own
          // hook directory, which is what makes a relative `./guard.mjs` resolve.
          "writeFileSync(join(process.env.PI_HOOK_CWD, 'audit.json'), JSON.stringify({",
          "  event: event.event, tool: event.toolName, command: event.input.command,",
          "  airId: process.env.AIR_HOOK_ID, ranFrom: process.cwd(),",
          "}));",
        ].join("\n"),
      ),
    });
    expectCleanRun(result);
    const audited = JSON.parse(readFileSync(join(result.cwd, "audit.json"), "utf8"));
    expect(audited).toMatchObject({
      event: "tool_call",
      tool: "bash",
      command: "echo audited",
      airId: "@local/custom-guard",
    });
    // AIR runs a hook from its own directory, so a relative `./guard.mjs` resolves.
    expect(audited.ranFrom).toBe(join(result.cwd, "hooks", "custom-guard"));
  });

  it("reports an AIR event Pi cannot support instead of silently never firing", async () => {
    const result = await runPi({
      script: [{ type: "text", text: "ok" }],
      prompt: "hello",
      files: customCatalog(
        { event: "pre_commit", command: "node", args: ["./guard.mjs"] },
        "process.exit(0);",
      ),
    });
    expectCleanRun(result);
    expect(result.stderr).toContain('AIR event "pre_commit" is not activated');
    expect(result.stderr).toContain("Pi has no git-commit lifecycle event");
  });
});
