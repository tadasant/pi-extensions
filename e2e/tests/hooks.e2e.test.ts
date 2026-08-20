/**
 * End-to-end: every test here boots the real pinned Pi CLI, pointed at a simulated
 * LLM on localhost, and asserts on Pi's own `--mode json` event stream. Nothing in
 * the loop is a stub except the model.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOOKS_PACKAGE_DIR,
  PI_VERSION,
  type PiRunResult,
  runPi,
  toolResults,
} from "../harness/pi.ts";

/** Assert Pi ran to completion instead of dying on a config or provider error. */
function expectCleanRun(result: PiRunResult): void {
  expect(result.exitCode, `pi exited ${result.exitCode}\nSTDERR:\n${result.stderr}`).toBe(0);
  expect(result.eventsOfType("agent_end").length).toBeGreaterThan(0);
}

describe("harness", () => {
  it("drives the pinned Pi binary, not a stub", async () => {
    const result = await runPi({
      script: [{ type: "text", text: "Hello from the simulated model." }],
      prompt: "say hi",
    });
    expectCleanRun(result);
    // The session header is emitted by Pi itself, and names the real cwd.
    const [session] = result.eventsOfType("session");
    expect(session?.cwd).toBe(result.cwd);
    expect(result.transcriptText()).toContain("Hello from the simulated model.");
    // Proof the model traffic went to localhost and nowhere else.
    expect(result.llm.requests.length).toBeGreaterThan(0);
    expect(result.llm.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(result.stderr).toContain("[pi-hooks] loaded");
  });

  it("reports the pinned version from the binary under test", async () => {
    expect(PI_VERSION).toBe("0.84.2");
  });

  it("runs real tools when no hook interferes", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "echo untouched-by-hooks" } },
        { type: "text", text: "done" },
      ],
      prompt: "run a command",
      hooksConfig: { hooks: [] },
    });
    expectCleanRun(result);
    const [call] = toolResults(result);
    expect(call?.isError).toBe(false);
    expect(call?.text).toContain("untouched-by-hooks");
  });
});

describe("tool_call blocking", () => {
  it("blocks a matching bash command and hands the reason back to the model", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "rm -rf /tmp/should-not-happen" } },
        { type: "text", text: "understood" },
      ],
      prompt: "clean up",
      hooksConfig: {
        hooks: [
          {
            name: "no-recursive-delete",
            on: "tool_call",
            match: { tool: "bash", input: { command: "/rm\\s+-rf/" } },
            action: { type: "block", reason: "blocked by e2e: {{input.command}}" },
          },
        ],
      },
    });
    expectCleanRun(result);
    const [call] = toolResults(result);
    expect(call?.isError).toBe(true);
    expect(call?.text).toBe("blocked by e2e: rm -rf /tmp/should-not-happen");
    expect(result.stderr).toContain("[pi-hooks] blocked bash");
  });

  it("leaves a non-matching command alone", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "echo safe" } },
        { type: "text", text: "ok" },
      ],
      prompt: "run something safe",
      hooksConfig: {
        hooks: [
          {
            name: "no-recursive-delete",
            on: "tool_call",
            match: { tool: "bash", input: { command: "/rm\\s+-rf/" } },
            action: { type: "block", reason: "should not fire" },
          },
        ],
      },
    });
    expectCleanRun(result);
    const [call] = toolResults(result);
    expect(call?.isError).toBe(false);
    expect(call?.text).toContain("safe");
  });

  it("prevents the side effect, not just the transcript entry", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "touch SHOULD_NOT_EXIST" } },
        { type: "text", text: "ok" },
      ],
      prompt: "create a file",
      hooksConfig: {
        hooks: [
          {
            name: "no-touch",
            on: "tool_call",
            match: { tool: "bash", input: { command: "/touch/" } },
            action: { type: "block", reason: "nope" },
          },
        ],
      },
    });
    expectCleanRun(result);
    expect(existsSync(join(result.cwd, "SHOULD_NOT_EXIST"))).toBe(false);
  });
});

describe("patch-input", () => {
  it("rewrites the tool input Pi actually executes", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "echo original" } },
        { type: "text", text: "ok" },
      ],
      prompt: "run it",
      hooksConfig: {
        hooks: [
          {
            name: "rewrite",
            on: "tool_call",
            match: { tool: "bash" },
            action: {
              type: "patch-input",
              set: { command: "echo patched-by-hook && {{input.command}}" },
            },
          },
        ],
      },
    });
    expectCleanRun(result);
    const [call] = toolResults(result);
    // The bash tool really ran the patched command, so the mutation reached Pi's
    // executor and not just our own copy of the input.
    expect(call?.text).toContain("patched-by-hook");
    expect(call?.text).toContain("original");
    // `tool_execution_start` fires *before* `tool_call` in Pi's documented lifecycle,
    // so it still carries the model's original arguments. Asserting that keeps the
    // test honest about where in the pipeline the patch lands.
    const [start] = result.eventsOfType("tool_execution_start");
    expect(start).toBeDefined();
    expect((start?.args as { command: string } | undefined)?.command).toBe("echo original");
  });
});

describe("command actions", () => {
  it("runs a script, feeds it the event, and lets a zero exit pass the call through", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "echo audited" } },
        { type: "text", text: "ok" },
      ],
      prompt: "run it",
      files: { "audit.sh": "#!/bin/sh\ncat > audit.json\nexit 0\n" },
      hooksConfig: {
        hooks: [
          {
            name: "audit",
            on: "tool_call",
            match: { tool: "bash" },
            action: { type: "command", command: "sh audit.sh" },
          },
        ],
      },
    });
    expectCleanRun(result);
    const audited = JSON.parse(readFileSync(join(result.cwd, "audit.json"), "utf8"));
    expect(audited.event).toBe("tool_call");
    expect(audited.toolName).toBe("bash");
    expect(audited.input.command).toBe("echo audited");
    expect(toolResults(result)[0]?.isError).toBe(false);
  });

  it("blocks the call when the script exits non-zero", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "echo denied" } },
        { type: "text", text: "ok" },
      ],
      prompt: "run it",
      hooksConfig: {
        hooks: [
          {
            name: "policy",
            on: "tool_call",
            match: { tool: "bash" },
            action: { type: "command", command: "echo 'policy says no' >&2; exit 1" },
          },
        ],
      },
    });
    expectCleanRun(result);
    const [call] = toolResults(result);
    expect(call?.isError).toBe(true);
    expect(call?.text).toContain("policy says no");
  });

  it("honours a JSON control object on stdout", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "echo before" } },
        { type: "text", text: "ok" },
      ],
      prompt: "run it",
      hooksConfig: {
        hooks: [
          {
            name: "control",
            on: "tool_call",
            match: { tool: "bash" },
            action: {
              type: "command",
              command: `printf '{"patchInput":{"command":"echo after-control"}}'`,
            },
          },
        ],
      },
    });
    expectCleanRun(result);
    expect(toolResults(result)[0]?.text).toContain("after-control");
  });
});

describe("tool_result", () => {
  it("rewrites a tool result before the model sees it", async () => {
    // The secret lives only in a file, never in the command text, so the sole way
    // it could reach the model is through the tool result the hook rewrites.
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "cat secret.txt" } },
        { type: "text", text: "ok" },
      ],
      prompt: "print it",
      files: { "secret.txt": "sk-live-SECRET-VALUE\n" },
      hooksConfig: {
        hooks: [
          {
            name: "redact",
            on: "tool_result",
            match: { tool: "bash", input: { command: "/secret/" } },
            action: { type: "command", command: `printf '{"content":"[redacted by hook]"}'` },
          },
        ],
      },
    });
    expectCleanRun(result);
    const resultMessages = result
      .eventsOfType("message_end")
      .filter((event) => (event.message as { role?: string })?.role === "toolResult");
    const text = JSON.stringify(resultMessages);
    expect(text).toContain("[redacted by hook]");
    expect(text).not.toContain("sk-live-SECRET-VALUE");
    // The strongest assertion: the secret never made it into a request to the model.
    expect(JSON.stringify(result.llm.requests)).not.toContain("sk-live-SECRET-VALUE");
  });
});

describe("before_agent_start", () => {
  it("injects configured context into the conversation", async () => {
    const result = await runPi({
      script: [{ type: "text", text: "ack" }],
      prompt: "hello",
      hooksConfig: {
        hooks: [
          {
            name: "inject",
            on: "before_agent_start",
            action: { type: "context", text: "HOOK-INJECTED-CONTEXT for {{prompt}}" },
          },
        ],
      },
    });
    expectCleanRun(result);
    // The strongest proof: it reached the model's request payload.
    expect(JSON.stringify(result.llm.requests)).toContain("HOOK-INJECTED-CONTEXT for hello");
  });
});

describe("session lifecycle", () => {
  it("fires session_start hooks during a real startup", async () => {
    const result = await runPi({
      script: [{ type: "text", text: "ok" }],
      prompt: "hi",
      hooksConfig: {
        hooks: [
          {
            name: "startup-marker",
            on: "session_start",
            action: { type: "command", command: "echo {{event}} > session-start.txt" },
          },
        ],
      },
    });
    expectCleanRun(result);
    expect(readFileSync(join(result.cwd, "session-start.txt"), "utf8").trim()).toBe(
      "session_start",
    );
  });

  it("surfaces notify actions", async () => {
    const result = await runPi({
      script: [{ type: "text", text: "ok" }],
      prompt: "hi",
      hooksConfig: {
        hooks: [
          {
            name: "greeter",
            on: "session_start",
            action: { type: "notify", message: "hooks are live", level: "info" },
          },
        ],
      },
    });
    expectCleanRun(result);
    expect(result.stderr).toContain("notify(info): hooks are live");
  });
});

describe("configuration", () => {
  it("reports a bad config without taking the session down", async () => {
    const result = await runPi({
      script: [{ type: "text", text: "still works" }],
      prompt: "hi",
      hooksConfig: '{ "hooks": [ { "on": "not_an_event", "action": { "type": "block" } } ] }',
    });
    expectCleanRun(result);
    expect(result.stderr).toContain("unknown event");
    expect(result.transcriptText()).toContain("still works");
  });

  it("accepts comments in hooks.json", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "echo x" } },
        { type: "text", text: "ok" },
      ],
      prompt: "run it",
      hooksConfig: `{
        // Block everything, with an explanation the user can read.
        "hooks": [ { "name": "commented", "on": "tool_call", "action": { "type": "block", "reason": "from a commented config" } } ]
      }`,
    });
    expectCleanRun(result);
    expect(toolResults(result)[0]?.text).toBe("from a commented config");
  });

  it("loads a config handed over by PI_HOOKS_CONFIG", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "echo x" } },
        { type: "text", text: "ok" },
      ],
      prompt: "run it",
      files: {
        "custom-hooks.json": JSON.stringify({
          hooks: [
            {
              name: "from-env",
              on: "tool_call",
              action: { type: "block", reason: "blocked from PI_HOOKS_CONFIG" },
            },
          ],
        }),
      },
      env: { PI_HOOKS_CONFIG: "custom-hooks.json" },
    });
    expectCleanRun(result);
    expect(toolResults(result)[0]?.text).toBe("blocked from PI_HOOKS_CONFIG");
  });
});

describe("packaging", () => {
  it("loads as a pi package directory, the way `pi install` would", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "bash", args: { command: "echo x" } },
        { type: "text", text: "ok" },
      ],
      prompt: "run it",
      // A directory spec makes Pi read package.json's `pi.extensions` manifest,
      // which is exactly the path `pi install npm:@tadasant/pi-hooks` takes.
      extensions: [HOOKS_PACKAGE_DIR],
      hooksConfig: {
        hooks: [
          {
            name: "via-package",
            on: "tool_call",
            action: { type: "block", reason: "loaded via the pi package manifest" },
          },
        ],
      },
    });
    expectCleanRun(result);
    expect(toolResults(result)[0]?.text).toBe("loaded via the pi package manifest");
  });
});
