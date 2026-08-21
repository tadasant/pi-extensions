/**
 * Translating AIR hooks onto the pi-hooks engine.
 *
 * AIR's hook vocabulary is agent-agnostic and broader than Pi's surface, so the
 * interesting cases are the mapping itself and what happens to the events Pi has no
 * equivalent for.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EVENT_MAP,
  interpolate,
  mergeXConfig,
  translateHook,
  UNSUPPORTED_EVENTS,
} from "../src/hooks-bridge.ts";
import type { Artifact, HookEntry, TranslatedHook } from "../src/types.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-plugins-hooks-"));
});

/** Build a hooks-index artifact whose HOOK.json holds `definition`. */
function hookArtifact(definition: unknown, entry: Partial<HookEntry> = {}): Artifact<HookEntry> {
  const hookDir = join(dir, "hooks", "sample");
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(join(hookDir, "HOOK.json"), JSON.stringify(definition));
  const source = join(dir, "hooks.json");
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, "{}");
  return {
    id: "@local/sample",
    shortId: "sample",
    scope: "local",
    entry: { description: "d", path: "hooks/sample", ...entry },
    source,
  };
}

/** The translated matcher, asserting the hook translated at all. */
function matchOf(translated: TranslatedHook | undefined): unknown {
  expect(translated).toBeDefined();
  return (translated?.definition as PiHookShape | undefined)?.match;
}

interface PiHookShape {
  name: string;
  on: string;
  match?: unknown;
  action: {
    type: string;
    command?: string;
    argv?: string[];
    cwd: string;
    env: Record<string, string>;
    timeoutMs?: number;
  };
}

describe("event mapping", () => {
  it("maps AIR's snake_case lifecycle events onto Pi's", () => {
    expect(EVENT_MAP.session_start).toBe("session_start");
    expect(EVENT_MAP.session_end).toBe("session_shutdown");
    expect(EVENT_MAP.pre_tool_call).toBe("tool_call");
    expect(EVENT_MAP.post_tool_call).toBe("tool_result");
    expect(EVENT_MAP.user_prompt_submit).toBe("user_prompt");
    expect(EVENT_MAP.stop).toBe("agent_settled");
  });

  it("accepts Claude Code's PascalCase spellings, which AIR treats as identities", () => {
    expect(EVENT_MAP.SessionStart).toBe("session_start");
    expect(EVENT_MAP.PreToolUse).toBe("tool_call");
    expect(EVENT_MAP.UserPromptSubmit).toBe("user_prompt");
  });

  it("warns with a reason rather than silently dropping an unmappable event", () => {
    const warnings: string[] = [];
    const translated = translateHook(
      hookArtifact({ event: "pre_commit", command: "./x.sh" }),
      warnings,
    );
    expect(translated).toBeUndefined();
    expect(warnings[0]).toContain('AIR event "pre_commit" is not activated');
    expect(warnings[0]).toContain("Pi has no git-commit lifecycle event");
  });

  it("names every AIR event it cannot support", () => {
    // A hook that never fires is worse than one that refuses to load, so each of
    // these has an explanation attached rather than falling through to "unknown".
    for (const event of [
      "pre_commit",
      "post_commit",
      "subagent_stop",
      "notification",
      "pre_compact",
    ]) {
      expect(UNSUPPORTED_EVENTS[event]).toBeTruthy();
    }
  });
});

describe("HOOK.json translation", () => {
  it("uses argv when the hook declares args", () => {
    const warnings: string[] = [];
    const translated = translateHook(
      hookArtifact({
        event: "pre_tool_call",
        command: "npx",
        args: ["lint-staged"],
        timeout_seconds: 30,
      }),
      warnings,
    );
    const definition = translated?.definition as PiHookShape;
    expect(warnings).toEqual([]);
    expect(definition.on).toBe("tool_call");
    expect(definition.name).toBe("@local/sample");
    expect(definition.action.argv).toEqual(["npx", "lint-staged"]);
    expect(definition.action.timeoutMs).toBe(30_000);
    expect(definition.action.cwd).toBe(join(dir, "hooks", "sample"));
  });

  it("runs a bare command through a shell, because AIR calls it a shell command", () => {
    // `docs/hooks.md`: "command — Shell command to execute". An argv-only form turns
    // a spec-valid `foo && bar` into a spawn ENOENT that blocks every tool call.
    const translated = translateHook(
      hookArtifact({ event: "pre_tool_call", command: "echo checking && exit 0" }),
      [],
    );
    const definition = translated?.definition as PiHookShape;
    expect(definition.action.command).toBe("echo checking && exit 0");
    expect(definition.action.argv).toBeUndefined();
  });

  it("runs the hook from its own directory, so ./script.sh resolves", () => {
    const translated = translateHook(
      hookArtifact({ event: "session_start", command: "./notify.sh" }),
      [],
    );
    const definition = translated?.definition as PiHookShape;
    expect(definition.action.command).toBe("./notify.sh");
    expect(definition.action.cwd).toBe(join(dir, "hooks", "sample"));
  });

  it("scopes an AIR matcher to the fields the event actually carries", () => {
    // Matching every field on every event lets a guardrail written for bash veto an
    // unrelated write whose path merely contains the word.
    const translated = translateHook(
      hookArtifact({ event: "pre_tool_call", matcher: "deploy.*production", command: "./x.sh" }),
      [],
    );
    expect(matchOf(translated)).toEqual({
      any: [{ tool: "/deploy.*production/i" }, { input: { command: "/deploy.*production/i" } }],
    });
  });

  it("matches Claude Code tool names, whose events this bridge already accepts", () => {
    // A Claude-authored hook's matcher is a PascalCase tool name; without an alias it
    // would never match Pi's lowercase names and would silently never fire.
    const translated = translateHook(
      hookArtifact({ event: "PreToolUse", matcher: "Bash", command: "./x.sh" }),
      [],
    );
    const match = matchOf(translated) as { any: unknown[] };
    expect(match.any).toContainEqual({ tool: "bash" });
    expect(match.any).toContainEqual({ tool: "/Bash/i" });
  });

  it("matches the prompt, and only the prompt, on user_prompt_submit", () => {
    const translated = translateHook(
      hookArtifact({ event: "user_prompt_submit", matcher: "deploy", command: "./x.sh" }),
      [],
    );
    expect(matchOf(translated)).toEqual({ prompt: "/deploy/i" });
  });

  it("omits the matcher entirely when the hook does not declare one", () => {
    const translated = translateHook(hookArtifact({ event: "stop", command: "./x.sh" }), []);
    expect(translated).toBeDefined();
    expect((translated?.definition as PiHookShape | undefined)?.match).toBeUndefined();
  });

  it("interpolates ${VAR} in env from the environment", () => {
    const translated = translateHook(
      hookArtifact({
        event: "session_start",
        command: "./x.sh",
        env: { WEBHOOK_URL: "${SLACK_WEBHOOK_URL}", LITERAL: "kept" },
      }),
      [],
      { env: { SLACK_WEBHOOK_URL: "https://hooks.example/abc" } },
    );
    const definition = translated?.definition as PiHookShape;
    expect(definition.action.env.WEBHOOK_URL).toBe("https://hooks.example/abc");
    expect(definition.action.env.LITERAL).toBe("kept");
  });

  it("leaves an unset ${VAR} untouched rather than blanking it", () => {
    expect(interpolate("${MISSING}/x", {})).toBe("${MISSING}/x");
    expect(interpolate("${SET}/x", { SET: "v" })).toBe("v/x");
  });

  it("exposes the AIR hook id and merged x-config to the script", () => {
    const translated = translateHook(
      hookArtifact(
        { event: "session_start", command: "./x.sh", "x-config": { severity: "warn", keep: 1 } },
        { "x-config": { severity: "error" } },
      ),
      [],
    );
    const definition = translated?.definition as PiHookShape;
    expect(definition.action.env.AIR_HOOK_ID).toBe("@local/sample");
    expect(JSON.parse(definition.action.env.AIR_HOOK_CONFIG as string)).toEqual({
      severity: "error",
      keep: 1,
    });
  });

  it("rejects a HOOK.json missing its required fields, naming the hook", () => {
    expect(() => translateHook(hookArtifact({ command: "./x.sh" }), [])).toThrow(
      /"event" is required/,
    );
    expect(() => translateHook(hookArtifact({ event: "stop" }), [])).toThrow(
      /"command" is required/,
    );
  });

  it("reports a missing HOOK.json rather than resolving to nothing", () => {
    const artifact = hookArtifact({ event: "stop", command: "./x.sh" });
    artifact.entry.path = "hooks/absent";
    expect(() => translateHook(artifact, [])).toThrow(/missing .*HOOK\.json/);
  });

  it("refuses a remote provider URI rather than pretending to resolve it", () => {
    const artifact = hookArtifact({ event: "stop", command: "./x.sh" });
    artifact.entry.path = "github://owner/repo/hooks/x";
    expect(() => translateHook(artifact, [])).toThrow(/remote provider URI/);
  });
});

describe("mergeXConfig", () => {
  it("deep-merges objects with the consumer winning", () => {
    expect(mergeXConfig({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
  });

  it("replaces arrays and scalars rather than merging them", () => {
    expect(mergeXConfig({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
    expect(mergeXConfig({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("handles either side being absent", () => {
    expect(mergeXConfig(undefined, undefined)).toBeUndefined();
    expect(mergeXConfig({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(mergeXConfig(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});
