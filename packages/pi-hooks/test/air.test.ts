/**
 * AIR hooks — the artifact format this package runs.
 *
 * Asserted against https://github.com/pulsemcp/air's `hooks.schema.json` and
 * `docs/hooks.md`: a `hooks.json` index of `{ description, path }` entries pointing
 * at directories whose `HOOK.json` holds `event`, `command`, `args`, `env`,
 * `timeout_seconds`, `matcher`, and `x-config`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AIR_EVENT_MAP,
  buildAirMatch,
  discoverAirConfig,
  discoverAirHookIndexes,
  interpolate,
  interpolateDeep,
  isAirHooksIndex,
  loadAirHooksIndex,
  mergeXConfig,
  readHookJson,
  UNSUPPORTED_AIR_EVENTS,
} from "../src/air.ts";
import type { HookDefinition } from "../src/types.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-hooks-air-"));
});

function write(relative: string, body: unknown): string {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  return path;
}

interface CommandAction {
  type: string;
  command?: string;
  argv?: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

const actionOf = (hook: HookDefinition) => hook.action as unknown as CommandAction;

/** A one-hook AIR catalog; returns the loaded definitions and any warnings. */
function loadOne(
  hookJson: unknown,
  entry: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {},
): { hooks: HookDefinition[]; warnings: string[] } {
  write("hooks/sample/HOOK.json", hookJson);
  const index = write("hooks.json", {
    sample: { description: "d", path: "hooks/sample", ...entry },
  });
  const warnings: string[] = [];
  return { hooks: loadAirHooksIndex(index, warnings, { env }), warnings };
}

describe("event mapping", () => {
  it("maps AIR's snake_case lifecycle events onto Pi's", () => {
    expect(AIR_EVENT_MAP.session_start).toBe("session_start");
    expect(AIR_EVENT_MAP.session_end).toBe("session_shutdown");
    expect(AIR_EVENT_MAP.pre_tool_call).toBe("tool_call");
    expect(AIR_EVENT_MAP.post_tool_call).toBe("tool_result");
    expect(AIR_EVENT_MAP.user_prompt_submit).toBe("user_prompt");
    expect(AIR_EVENT_MAP.stop).toBe("agent_settled");
  });

  it("accepts Claude Code's PascalCase spellings, which AIR treats as identities", () => {
    expect(AIR_EVENT_MAP.SessionStart).toBe("session_start");
    expect(AIR_EVENT_MAP.PreToolUse).toBe("tool_call");
    expect(AIR_EVENT_MAP.UserPromptSubmit).toBe("user_prompt");
  });

  it("names every AIR event Pi cannot support", () => {
    // A hook that never fires is worse than one that refuses to load, so each of
    // these carries a reason rather than falling through to "unknown".
    for (const event of [
      "pre_commit",
      "post_commit",
      "subagent_stop",
      "notification",
      "pre_compact",
    ]) {
      expect(UNSUPPORTED_AIR_EVENTS[event]).toBeTruthy();
    }
  });

  it("warns with the reason rather than silently dropping an unmappable event", () => {
    const { hooks, warnings } = loadOne({ event: "pre_commit", command: "./x.sh" });
    expect(hooks).toEqual([]);
    expect(warnings[0]).toContain('AIR event "pre_commit" is not activated');
    expect(warnings[0]).toContain("Pi has no git-commit lifecycle event");
  });
});

describe("HOOK.json", () => {
  it("becomes a hook bound to the mapped Pi event, run from its own directory", () => {
    const { hooks, warnings } = loadOne({
      event: "pre_tool_call",
      command: "npx",
      args: ["lint-staged"],
      timeout_seconds: 30,
    });
    expect(warnings).toEqual([]);
    expect(hooks[0]?.name).toBe("@local/sample");
    expect(hooks[0]?.on).toBe("tool_call");
    const action = actionOf(hooks[0] as HookDefinition);
    // args present -> argv, so arguments pass through with no quoting hazard.
    expect(action.argv).toEqual(["npx", "lint-staged"]);
    expect(action.timeoutMs).toBe(30_000);
    expect(action.cwd).toBe(join(dir, "hooks", "sample"));
  });

  it("runs a bare command through a shell, because AIR calls it a shell command", () => {
    // docs/hooks.md: "command — Shell command to execute". An argv-only form would
    // turn a spec-valid `foo && bar` into a spawn error that blocks every tool call.
    const { hooks } = loadOne({ event: "pre_tool_call", command: "echo checking && exit 0" });
    const action = actionOf(hooks[0] as HookDefinition);
    expect(action.command).toBe("echo checking && exit 0");
    expect(action.argv).toBeUndefined();
  });

  it("interpolates ${VAR} in env and exposes the AIR hook id", () => {
    const { hooks } = loadOne(
      { event: "session_start", command: "./x.sh", env: { HOOK_URL: "${WEBHOOK}" } },
      {},
      { WEBHOOK: "https://example.test/x" },
    );
    const action = actionOf(hooks[0] as HookDefinition);
    expect(action.env.HOOK_URL).toBe("https://example.test/x");
    expect(action.env.AIR_HOOK_ID).toBe("@local/sample");
  });

  it("merges the index entry's x-config over the hook's own and interpolates it", () => {
    const { hooks } = loadOne(
      { event: "session_start", command: "./x.sh", "x-config": { severity: "warn", keep: 1 } },
      { "x-config": { severity: "error", url: "${WEBHOOK}" } },
      { WEBHOOK: "https://example.test/x" },
    );
    const action = actionOf(hooks[0] as HookDefinition);
    expect(JSON.parse(action.env.AIR_HOOK_CONFIG as string)).toEqual({
      severity: "error",
      keep: 1,
      url: "https://example.test/x",
    });
  });

  it("treats timeout_seconds: 0 as unset rather than an instant timeout", () => {
    const { hooks } = loadOne({ event: "stop", command: "./x.sh", timeout_seconds: 0 });
    expect(actionOf(hooks[0] as HookDefinition).timeoutMs).toBeUndefined();
  });

  it("reports a missing or malformed HOOK.json by hook id", () => {
    expect(() => readHookJson(join(dir, "absent"), "@local/x")).toThrow(/missing .*HOOK\.json/);
    write("hooks/bad/HOOK.json", { command: "./x.sh" });
    expect(() => readHookJson(join(dir, "hooks", "bad"), "@local/x")).toThrow(
      /"event" is required/,
    );
    write("hooks/bad2/HOOK.json", { event: "stop" });
    expect(() => readHookJson(join(dir, "hooks", "bad2"), "@local/x")).toThrow(
      /"command" is required/,
    );
  });

  it("rejects a malformed optional field by name", () => {
    // Only event and command used to be checked, so a string `args` — a plausible
    // typo, since AIR's docs show command/args as a pair — was spread character by
    // character into an argv that could not spawn, blocking every tool call with an
    // incomprehensible reason and no error naming the hook.
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ args: "./g.mjs" }, /"args" must be an array of strings/],
      [{ args: [1] }, /"args" must be an array of strings/],
      [{ env: "nope" }, /"env" must be an object/],
      [{ "x-config": [1, 2] }, /"x-config" must be an object/],
      [{ matcher: 7 }, /"matcher" must be a string/],
      [{ timeout_seconds: "5" }, /"timeout_seconds" must be a number/],
    ];
    for (const [extra, expected] of cases) {
      write("hooks/malformed/HOOK.json", { event: "stop", command: "node", ...extra });
      expect(
        () => readHookJson(join(dir, "hooks", "malformed"), "@local/malformed"),
        String(expected),
      ).toThrow(expected);
    }
  });

  it("accepts every optional field AIR permits, and their absence", () => {
    write("hooks/full/HOOK.json", {
      event: "pre_tool_call",
      command: "node",
      args: ["./g.mjs"],
      env: { A: "1" },
      "x-config": { a: 1 },
      matcher: "bash",
      timeout_seconds: 5,
    });
    expect(() => readHookJson(join(dir, "hooks", "full"), "@local/full")).not.toThrow();
    write("hooks/min/HOOK.json", { event: "stop", command: "./x.sh" });
    expect(() => readHookJson(join(dir, "hooks", "min"), "@local/min")).not.toThrow();
  });

  it("keeps loading the rest of an index when one hook is broken", () => {
    write("hooks/good/HOOK.json", { event: "stop", command: "./ok.sh" });
    const index = write("hooks.json", {
      broken: { description: "d", path: "hooks/absent" },
      good: { description: "d", path: "hooks/good" },
    });
    const warnings: string[] = [];
    const hooks = loadAirHooksIndex(index, warnings);
    expect(hooks.map((hook) => hook.name)).toEqual(["@local/good"]);
    expect(warnings[0]).toContain("@local/broken");
  });

  it("refuses a remote provider URI rather than pretending to resolve it", () => {
    const index = write("hooks.json", {
      remote: { description: "d", path: "github://owner/repo/hooks/x" },
    });
    const warnings: string[] = [];
    expect(loadAirHooksIndex(index, warnings)).toEqual([]);
    expect(warnings[0]).toContain("remote provider URI");
  });
});

describe("matchers", () => {
  it("scopes an AIR matcher to the fields the event actually carries", () => {
    // Matching every field on every event would let a bash guardrail veto an
    // unrelated write whose path merely contains the word.
    expect(buildAirMatch("deploy.*production", "tool_call")).toEqual({
      any: [{ tool: "/deploy.*production/i" }, { input: { command: "/deploy.*production/i" } }],
    });
    expect(buildAirMatch("deploy", "user_prompt")).toEqual({ prompt: "/deploy/i" });
    // session events carry a `reason`, which is the only data there is to filter on.
    expect(buildAirMatch("resume", "session_start")).toEqual({ reason: "/resume/i" });
    expect(buildAirMatch("quit", "session_shutdown")).toEqual({ reason: "/quit/i" });
    expect(buildAirMatch(undefined, "tool_call")).toBeUndefined();
  });

  it("warns rather than silently dropping a matcher on an event with no payload", () => {
    const warnings: string[] = [];
    expect(buildAirMatch("anything", "agent_settled", warnings, "@local/x")).toBeUndefined();
    expect(warnings[0]).toContain("carries no data to match");
  });

  it("keeps a matcher that names a tool off the command, to avoid false refusals", () => {
    // `write` must not also fire on `git write-tree` …
    expect(buildAirMatch("write", "tool_call")).toEqual({ tool: "/write/i" });
    expect(buildAirMatch("Bash", "tool_call")).toEqual({
      any: [{ tool: "/Bash/i" }, { tool: "bash" }],
    });
    // … but a word that is not a tool name is a pattern over the command, which is
    // what AIR's "matched against event data" means for a tool event.
    expect(buildAirMatch("deploy", "tool_call")).toEqual({
      any: [{ tool: "/deploy/i" }, { input: { command: "/deploy/i" } }],
    });
    expect(buildAirMatch("deploy.*prod", "tool_call")).toEqual({
      any: [{ tool: "/deploy.*prod/i" }, { input: { command: "/deploy.*prod/i" } }],
    });
  });

  it("matches Claude Code tool names, whose events this package already accepts", () => {
    const match = buildAirMatch("Bash", "tool_call") as { any: unknown[] };
    expect(match.any).toContainEqual({ tool: "bash" });
    expect(match.any).toContainEqual({ tool: "/Bash/i" });
  });
});

describe("interpolation and x-config merge", () => {
  it("leaves an unset ${VAR} untouched rather than blanking it", () => {
    expect(interpolate("${MISSING}/x", {})).toBe("${MISSING}/x");
    expect(interpolate("${SET}/x", { SET: "v" })).toBe("v/x");
  });

  it("interpolates every string leaf, at any depth", () => {
    expect(interpolateDeep({ a: ["${V}", 1], b: { c: "${V}" } }, { V: "x" })).toEqual({
      a: ["x", 1],
      b: { c: "x" },
    });
  });

  it("deep-merges objects with the consumer winning; arrays and scalars replace", () => {
    expect(mergeXConfig({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
    expect(mergeXConfig({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
    expect(mergeXConfig(undefined, undefined)).toBeUndefined();
    expect(mergeXConfig({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

describe("format discrimination", () => {
  it("recognises an AIR hooks index", () => {
    expect(isAirHooksIndex({ "a-hook": { description: "d", path: "hooks/a" } })).toBe(true);
    expect(isAirHooksIndex({ $schema: "x", a: { description: "d", path: "p" } })).toBe(true);
  });

  it("does not mistake this package's own superset for one", () => {
    // The Pi-native config has a `hooks` array; an AIR index is a map of entries.
    expect(isAirHooksIndex({ hooks: [{ on: "tool_call", action: { type: "block" } }] })).toBe(
      false,
    );
    expect(isAirHooksIndex({ extends: ["preset:secrets"] })).toBe(false);
    expect(isAirHooksIndex({})).toBe(false);
    expect(isAirHooksIndex({ a: { description: "d" } })).toBe(false);
  });
});

describe("air.json discovery", () => {
  it("finds air.json, then .air/air.json, and honours PI_HOOKS_AIR", () => {
    write("air.json", { name: "x" });
    expect(discoverAirConfig(dir, {})).toBe(join(dir, "air.json"));
    const explicit = write("custom/air.json", { name: "x" });
    expect(discoverAirConfig(dir, { PI_HOOKS_AIR: "custom/air.json" })).toBe(explicit);
    expect(discoverAirConfig(dir, {})).toBeDefined();
  });

  it("returns undefined when there is no AIR config", () => {
    expect(discoverAirConfig(dir, {})).toBeUndefined();
  });

  it("collects hook indexes from both the hooks array and walked catalogs", () => {
    // A walked hooks.json must look like an AIR index to be collected; a Pi-native
    // one inside a catalog tree would otherwise produce a warning per key.
    write("standalone/hooks.json", { a: { description: "d", path: "hooks/a" } });
    write("catalog/nested/hooks.json", { b: { description: "d", path: "hooks/b" } });
    const config = write("air.json", {
      name: "x",
      hooks: ["./standalone/hooks.json"],
      catalogs: ["./catalog"],
    });
    const warnings: string[] = [];
    expect(discoverAirHookIndexes(config, warnings).sort()).toEqual(
      [join(dir, "standalone", "hooks.json"), join(dir, "catalog", "nested", "hooks.json")].sort(),
    );
    expect(warnings).toEqual([]);
  });

  it("warns about a missing index or catalog, and about a remote catalog", () => {
    const config = write("air.json", {
      name: "x",
      hooks: ["./nope.json"],
      catalogs: ["./gone", "github://owner/repo"],
    });
    const warnings: string[] = [];
    discoverAirHookIndexes(config, warnings);
    expect(warnings.join("\n")).toContain("does not exist");
    expect(warnings.join("\n")).toContain("remote provider URI");
  });
});
