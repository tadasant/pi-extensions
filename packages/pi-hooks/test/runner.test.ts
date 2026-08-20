import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  hookEnv,
  MAX_CAPTURED_OUTPUT_BYTES,
  MAX_ENV_VALUE_BYTES,
  parseControl,
  runCommandAction,
} from "../src/actions.ts";
import { HookRunner } from "../src/runner.ts";
import type { HookDefinition, LoadedConfig } from "../src/types.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-hooks-runner-"));
});

function configOf(...definitions: HookDefinition[]): LoadedConfig {
  return {
    hooks: definitions.map((definition, index) => ({ definition, source: "test", index })),
    sources: ["test"],
    errors: [],
  };
}

function makeRunner(...definitions: HookDefinition[]) {
  const logs: string[] = [];
  const runner = new HookRunner(configOf(...definitions), {
    cwd: dir,
    log: (line) => logs.push(line),
  });
  return { runner, logs };
}

describe("parseControl", () => {
  it("parses a JSON object on stdout", () => {
    expect(parseControl(' {"block":true,"reason":"no"} ')).toEqual({ block: true, reason: "no" });
  });

  it("ignores plain output", () => {
    expect(parseControl("hello")).toBeUndefined();
    expect(parseControl("{ not json }")).toBeUndefined();
    expect(parseControl("")).toBeUndefined();
  });
});

describe("hookEnv", () => {
  it("flattens the common fields and JSON-encodes the rest", () => {
    const env = hookEnv({ event: "tool_call", toolName: "bash", input: { command: "ls" } });
    expect(env.PI_HOOK).toBe("1");
    expect(env.PI_HOOK_EVENT).toBe("tool_call");
    expect(env.PI_HOOK_TOOL).toBe("bash");
    expect(JSON.parse(env.PI_HOOK_INPUT as string)).toEqual({ command: "ls" });
    expect(env.PI_HOOK_PROMPT).toBeUndefined();
  });
});

describe("HookRunner dispatch", () => {
  it("does nothing when no hook matches", async () => {
    const { runner } = makeRunner({
      on: "tool_call",
      match: { tool: "read" },
      action: { type: "block" },
    });
    const outcome = await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    expect(outcome.blocked).toBe(false);
    expect(outcome.ran).toEqual([]);
  });

  it("blocks with a templated reason", async () => {
    const { runner } = makeRunner({
      name: "no-env",
      on: "tool_call",
      match: { tool: "write", input: { path: "**/.env" } },
      action: { type: "block", reason: "not {{input.path}}" },
    });
    const outcome = await runner.dispatch({
      event: "tool_call",
      toolName: "write",
      input: { path: "app/.env" },
    });
    expect(outcome.blocked).toBe(true);
    expect(outcome.reason).toBe("not app/.env");
    expect(outcome.ran).toEqual(["no-env"]);
  });

  it("stops dispatching once a hook blocks", async () => {
    const { runner } = makeRunner(
      { name: "first", on: "tool_call", action: { type: "block", reason: "stop" } },
      { name: "second", on: "tool_call", action: { type: "notify", message: "never" } },
    );
    const outcome = await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    expect(outcome.ran).toEqual(["first"]);
    expect(outcome.notifications).toEqual([]);
  });

  it("patches tool input in place", async () => {
    const { runner } = makeRunner({
      on: "tool_call",
      match: { tool: "bash" },
      action: { type: "patch-input", set: { command: "set -e\n{{input.command}}" } },
    });
    const input: Record<string, unknown> = { command: "ls" };
    await runner.dispatch({ event: "tool_call", toolName: "bash", input });
    expect(input.command).toBe("set -e\nls");
  });

  it("collects notifications and context", async () => {
    const { runner } = makeRunner(
      { on: "session_start", action: { type: "notify", message: "hi", level: "warning" } },
      { on: "before_agent_start", action: { type: "context", text: "ctx {{prompt}}" } },
    );
    const started = await runner.dispatch({ event: "session_start" });
    expect(started.notifications).toEqual([{ message: "hi", level: "warning" }]);
    const agent = await runner.dispatch({ event: "before_agent_start", prompt: "p" });
    expect(agent.context).toEqual(["ctx p"]);
  });

  it("honours `once`", async () => {
    const { runner } = makeRunner({
      name: "once",
      on: "tool_call",
      once: true,
      action: { type: "notify", message: "x" },
    });
    const first = await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    const second = await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    expect(first.ran).toEqual(["once"]);
    expect(second.ran).toEqual([]);
  });

  it("resets `once` state when the config is replaced", async () => {
    const { runner } = makeRunner({
      name: "once",
      on: "tool_call",
      once: true,
      action: { type: "notify", message: "x" },
    });
    await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    runner.setConfig(runner.getConfig());
    const again = await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    expect(again.ran).toEqual(["once"]);
  });
});

describe("command actions", () => {
  it("runs a shell command and passes the event on stdin", async () => {
    const out = join(dir, "stdin.json");
    const { runner } = makeRunner({
      name: "capture",
      on: "tool_call",
      action: { type: "command", command: `cat > ${out}` },
    });
    await runner.dispatch({ event: "tool_call", toolName: "bash", input: { command: "ls" } });
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.event).toBe("tool_call");
    expect(payload.input).toEqual({ command: "ls" });
  });

  it("exposes PI_HOOK_* variables", async () => {
    const out = join(dir, "env.txt");
    const { runner } = makeRunner({
      on: "tool_call",
      action: { type: "command", command: `printf '%s' "$PI_HOOK_TOOL" > ${out}` },
    });
    await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    expect(readFileSync(out, "utf8")).toBe("bash");
  });

  it("blocks on a non-zero exit and reports stderr", async () => {
    const { runner } = makeRunner({
      name: "deny",
      on: "tool_call",
      action: { type: "command", command: "echo nope >&2; exit 3" },
    });
    const outcome = await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    expect(outcome.blocked).toBe(true);
    expect(outcome.reason).toContain("nope");
  });

  it("only logs a failure when blockOnFailure is false", async () => {
    const { runner, logs } = makeRunner({
      name: "advisory",
      on: "tool_call",
      action: { type: "command", command: "exit 1", blockOnFailure: false },
    });
    const outcome = await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    expect(outcome.blocked).toBe(false);
    expect(logs.join("\n")).toContain("advisory");
  });

  it("applies a JSON control object from stdout", async () => {
    const { runner } = makeRunner({
      on: "tool_call",
      action: {
        type: "command",
        command: `printf '{"block":true,"reason":"policy","terminate":true}'`,
      },
    });
    const outcome = await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    expect(outcome).toMatchObject({ blocked: true, reason: "policy", terminate: true });
  });

  it("applies patchInput and notify from a control object", async () => {
    const { runner } = makeRunner({
      on: "tool_call",
      action: {
        type: "command",
        command: `printf '{"patchInput":{"command":"safe"},"notify":"patched"}'`,
      },
    });
    const input: Record<string, unknown> = { command: "risky" };
    const outcome = await runner.dispatch({ event: "tool_call", toolName: "bash", input });
    expect(input.command).toBe("safe");
    expect(outcome.notifications[0]?.message).toBe("patched");
    expect(outcome.blocked).toBe(false);
  });

  it("does not let a templated value break out of the shell", async () => {
    const marker = join(dir, "pwned");
    const { runner } = makeRunner({
      on: "tool_call",
      action: { type: "command", command: "printf '%s' {{input.path}} > /dev/null" },
    });
    await runner.dispatch({
      event: "tool_call",
      toolName: "write",
      input: { path: `x'; touch ${marker}; echo '` },
    });
    expect(() => readFileSync(marker)).toThrow();
  });

  it("passes argv values through without a shell", async () => {
    const out = join(dir, "argv.txt");
    const { runner } = makeRunner({
      on: "tool_call",
      action: {
        type: "command",
        argv: [
          "node",
          "-e",
          `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.PI_HOOK_TOOL)`,
        ],
      },
    });
    await runner.dispatch({ event: "tool_call", toolName: "grep", input: {} });
    expect(readFileSync(out, "utf8")).toBe("grep");
  });

  it("kills and blocks on timeout", async () => {
    const { runner } = makeRunner({
      name: "slow",
      on: "tool_call",
      action: { type: "command", command: "sleep 5", timeoutMs: 100 },
    });
    const outcome = await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    expect(outcome.blocked).toBe(true);
    expect(outcome.reason).toContain("timed out");
  });

  it("reports a missing executable rather than throwing", async () => {
    const outcome = await runCommandAction(
      { type: "command", argv: ["definitely-not-a-real-binary-xyz"] },
      { event: "tool_call" },
      { cwd: dir },
    );
    expect(outcome.exitCode).toBe(127);
  });

  it("templates env values", async () => {
    const out = join(dir, "envval.txt");
    writeFileSync(out, "");
    const { runner } = makeRunner({
      on: "tool_call",
      action: {
        type: "command",
        command: `printf '%s' "$MY_VAR" > ${out}`,
        env: { MY_VAR: "tool-{{toolName}}" },
      },
    });
    await runner.dispatch({ event: "tool_call", toolName: "edit", input: {} });
    expect(readFileSync(out, "utf8")).toBe("tool-edit");
  });
});

describe("hardening", () => {
  it("ignores JSON on stdout that carries no control key", async () => {
    // eslint -f json / semgrep --json print JSON and exit non-zero. Treating that
    // as a control object would cancel the exit code and silently do nothing.
    const { runner } = makeRunner({
      name: "linter",
      on: "tool_call",
      action: { type: "command", command: `printf '{"errors":[1]}'; exit 1` },
    });
    const outcome = await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    expect(outcome.blocked).toBe(true);
    expect(outcome.reason).toContain("linter");
  });

  it("still accepts a real control object", async () => {
    const { runner } = makeRunner({
      on: "tool_call",
      action: { type: "command", command: `printf '{"block":true,"reason":"policy"}'; exit 1` },
    });
    const outcome = await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    expect(outcome).toMatchObject({ blocked: true, reason: "policy" });
  });

  it("logs rather than pretending to block on a non-blockable event", async () => {
    // `blocked` on session_start is dropped by the extension, so a swallowed
    // failure would be completely invisible.
    const { runner, logs } = makeRunner({
      name: "startup",
      on: "session_start",
      action: { type: "command", command: "echo boom >&2; exit 2" },
    });
    const outcome = await runner.dispatch({ event: "session_start" });
    expect(outcome.blocked).toBe(false);
    expect(logs.join("\n")).toContain("startup");
    expect(logs.join("\n")).toContain("boom");
  });

  it("refuses a prototype-polluting patchInput from a hook script", async () => {
    const { runner, logs } = makeRunner({
      name: "evil",
      on: "tool_call",
      action: { type: "command", command: `printf '{"patchInput":{"__proto__.pwned":true}}'` },
    });
    await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    expect(({} as Record<string, unknown>).pwned).toBeUndefined();
    expect(logs.join("\n")).toContain("evil");
  });

  it("does not let a throwing matcher escape dispatch", async () => {
    const { runner, logs } = makeRunner({
      name: "broken",
      on: "tool_call",
      match: { tool: 42 as never },
      action: { type: "block", reason: "never" },
    });
    const outcome = await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    expect(outcome.blocked).toBe(false);
    expect(logs.join("\n")).toContain("broken");
  });

  it("truncates oversized env values instead of failing to spawn", async () => {
    // A >128 KiB tool input used to make spawn throw E2BIG, so an audit hook
    // silently did not run on exactly the oversized write it exists to inspect.
    const out = join(dir, "size.txt");
    const { runner } = makeRunner({
      on: "tool_call",
      action: { type: "command", command: `printf '%s' "\${#PI_HOOK_INPUT}" > ${out}` },
    });
    const outcome = await runner.dispatch({
      event: "tool_call",
      toolName: "write",
      input: { content: "x".repeat(200_000) },
    });
    expect(outcome.blocked).toBe(false);
    const measured = Number(readFileSync(out, "utf8"));
    // Guard against a false pass: an empty file would also be "less than the cap".
    expect(measured).toBeGreaterThan(1_000);
    expect(measured).toBeLessThan(MAX_ENV_VALUE_BYTES + 200);
  });

  it("still delivers the untruncated event on stdin", async () => {
    const out = join(dir, "stdin-size.txt");
    const { runner } = makeRunner({
      on: "tool_call",
      action: { type: "command", command: `wc -c > ${out}` },
    });
    await runner.dispatch({
      event: "tool_call",
      toolName: "write",
      input: { content: "x".repeat(200_000) },
    });
    expect(Number(readFileSync(out, "utf8").trim())).toBeGreaterThan(200_000);
  });

  it("caps captured output so a runaway hook cannot exhaust the heap", async () => {
    const { runner } = makeRunner({
      name: "flood",
      on: "tool_call",
      action: { type: "command", command: "yes badger | head -c 5000000; exit 1" },
    });
    const outcome = await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    expect(outcome.blocked).toBe(true);
    expect((outcome.reason ?? "").length).toBeLessThan(MAX_CAPTURED_OUTPUT_BYTES + 5_000);
  });

  it("kills the whole process group on timeout", async () => {
    // Killing only /bin/sh leaves a pipeline's children running; the marker file
    // would appear a second after the hook "timed out".
    const marker = join(dir, "survivor.txt");
    const { runner } = makeRunner({
      name: "slow",
      on: "tool_call",
      action: { type: "command", command: `(sleep 1; touch ${marker}) & wait`, timeoutMs: 100 },
    });
    const outcome = await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    expect(outcome.reason).toContain("timed out");
    await new Promise((r) => setTimeout(r, 1_500));
    expect(existsSync(marker)).toBe(false);
  });

  it("records whether injected context should be displayed", async () => {
    const { runner } = makeRunner(
      { on: "before_agent_start", action: { type: "context", text: "quiet" } },
      { on: "before_agent_start", action: { type: "context", text: "loud", display: true } },
    );
    const outcome = await runner.dispatch({ event: "before_agent_start", prompt: "p" });
    expect(outcome.context).toEqual(["quiet", "loud"]);
    expect(outcome.contextDisplay).toBe(true);

    const { runner: quiet } = makeRunner({
      on: "before_agent_start",
      action: { type: "context", text: "quiet" },
    });
    expect((await quiet.dispatch({ event: "before_agent_start" })).contextDisplay).toBe(false);
  });
});

describe("error handling", () => {
  it("logs and continues when an action throws by default", async () => {
    const { runner, logs } = makeRunner(
      { name: "boom", on: "tool_call", action: { type: "patch-input", set: null as never } },
      { name: "after", on: "tool_call", action: { type: "notify", message: "still ran" } },
    );
    const outcome = await runner.dispatch({ event: "tool_call", toolName: "bash", input: {} });
    expect(logs.join("\n")).toContain("boom");
    expect(outcome.notifications[0]?.message).toBe("still ran");
  });

  it("rethrows when continueOnError is false", async () => {
    const { runner } = makeRunner({
      name: "boom",
      on: "tool_call",
      continueOnError: false,
      action: { type: "patch-input", set: null as never },
    });
    await expect(
      runner.dispatch({ event: "tool_call", toolName: "bash", input: {} }),
    ).rejects.toThrow();
  });
});
