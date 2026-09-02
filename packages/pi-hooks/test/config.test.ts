import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  discoverConfigPaths,
  hooksForEvent,
  listBuiltinAirHooks,
  loadConfig,
  stripJsonComments,
  validateHook,
} from "../src/config.ts";
import type { HookDefinition } from "../src/types.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-hooks-config-"));
});

function write(name: string, body: unknown): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

describe("stripJsonComments", () => {
  it("keeps newlines inside block comments so parse errors point at the right line", () => {
    const stripped = stripJsonComments('{\n/* a\nb\nc */\n"x": }');
    expect(stripped.split("\n")).toHaveLength(5);
  });

  it("removes line and block comments", () => {
    expect(stripJsonComments('{ // hi\n "a": 1 /* there */ }')).toContain('"a": 1');
    expect(JSON.parse(stripJsonComments('{ // hi\n"a": 1 }'))).toEqual({ a: 1 });
  });

  it("leaves comment-like text inside strings alone", () => {
    expect(JSON.parse(stripJsonComments('{"a": "http://x//y"}'))).toEqual({ a: "http://x//y" });
    expect(JSON.parse(stripJsonComments('{"a": "/* not a comment */"}'))).toEqual({
      a: "/* not a comment */",
    });
  });

  it("respects escaped quotes", () => {
    expect(JSON.parse(stripJsonComments('{"a": "say \\" // no"}'))).toEqual({ a: 'say " // no' });
  });
});

describe("discoverConfigPaths", () => {
  it("prefers PI_HOOKS_CONFIG and resolves relative entries against cwd", () => {
    const paths = discoverConfigPaths({
      cwd: "/work",
      agentDir: "/agent",
      env: { PI_HOOKS_CONFIG: "a.json:/abs/b.json" },
    });
    expect(paths).toEqual(["/work/a.json", "/abs/b.json"]);
  });

  it("finds the project config when it exists", () => {
    const projectDir = join(dir, ".pi");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "hooks.json"), "{}");
    const paths = discoverConfigPaths({ cwd: dir, agentDir: join(dir, "missing-agent"), env: {} });
    expect(paths).toEqual([join(projectDir, "hooks.json")]);
  });

  it("orders every user-level config before every project-level one", () => {
    // Regression guard: iterating filenames in the outer loop would put the
    // project's hooks.json ahead of the user's hooks.jsonc and invert precedence.
    const agentDir = join(dir, "agent");
    const projectDir = join(dir, ".pi");
    mkdirSync(agentDir);
    mkdirSync(projectDir);
    writeFileSync(join(agentDir, "hooks.jsonc"), "{}");
    writeFileSync(join(projectDir, "hooks.json"), "{}");
    expect(discoverConfigPaths({ cwd: dir, agentDir, env: {} })).toEqual([
      join(agentDir, "hooks.jsonc"),
      join(projectDir, "hooks.json"),
    ]);
  });
});

describe("validateHook", () => {
  const ok: HookDefinition = { on: "tool_call", action: { type: "block" } };

  it("accepts a well-formed hook", () => {
    expect(validateHook(ok, "x")).toEqual([]);
  });

  it("rejects unknown events and actions", () => {
    expect(validateHook({ on: "nope" as never, action: { type: "block" } }, "x")[0]).toContain(
      'unknown event "nope"',
    );
    expect(validateHook({ on: "tool_call", action: { type: "zap" } as never }, "x")[0]).toContain(
      'unknown action type "zap"',
    );
  });

  it("rejects a command action with neither command nor argv, and with both", () => {
    expect(validateHook({ on: "tool_call", action: { type: "command" } }, "x")[0]).toContain(
      'needs "command" or "argv"',
    );
    expect(
      validateHook(
        { on: "tool_call", action: { type: "command", command: "a", argv: ["b"] } },
        "x",
      )[0],
    ).toContain("cannot set both");
  });

  it("rejects a context action outside before_agent_start", () => {
    expect(
      validateHook({ on: "tool_call", action: { type: "context", text: "hi" } }, "x")[0],
    ).toContain("only apply to before_agent_start");
  });
});

describe("loadConfig", () => {
  it("loads hooks and records the source", () => {
    const path = write("hooks.json", {
      hooks: [{ name: "a", on: "tool_call", action: { type: "block" } }],
    });
    const config = loadConfig([path]);
    expect(config.errors).toEqual([]);
    expect(config.hooks).toHaveLength(1);
    expect(config.hooks[0]?.definition.name).toBe("a");
    expect(config.sources).toEqual([path]);
  });

  it("skips disabled hooks but keeps the rest", () => {
    const path = write("hooks.json", {
      hooks: [
        { name: "off", on: "tool_call", enabled: false, action: { type: "block" } },
        { name: "on", on: "tool_call", action: { type: "block" } },
      ],
    });
    expect(loadConfig([path]).hooks.map((h) => h.definition.name)).toEqual(["on"]);
  });

  it("merges extends before the file's own hooks", () => {
    write("base.json", { hooks: [{ name: "base", on: "tool_call", action: { type: "block" } }] });
    const path = write("hooks.json", {
      extends: ["./base.json"],
      hooks: [{ name: "own", on: "tool_call", action: { type: "block" } }],
    });
    expect(loadConfig([path]).hooks.map((h) => h.definition.name)).toEqual(["base", "own"]);
  });

  it("does not loop on circular extends", () => {
    write("a.json", { extends: ["./b.json"], hooks: [] });
    const b = write("b.json", { extends: ["./a.json"], hooks: [] });
    expect(() => loadConfig([b])).not.toThrow();
  });

  it("reports a parse error against the offending file and keeps going", () => {
    const bad = write("bad.json", "{ not json ");
    const good = write("good.json", {
      hooks: [{ name: "g", on: "tool_call", action: { type: "block" } }],
    });
    const config = loadConfig([bad, good]);
    expect(config.errors[0]).toContain(bad);
    expect(config.hooks).toHaveLength(1);
  });

  it("reports a missing file", () => {
    expect(loadConfig([join(dir, "nope.json")]).errors[0]).toContain("no such file");
  });

  it("drops an invalid hook but keeps its valid neighbours", () => {
    const path = write("hooks.json", {
      hooks: [
        { name: "bad", on: "not_an_event", action: { type: "block" } },
        { name: "good", on: "tool_call", action: { type: "block" } },
      ],
    });
    const config = loadConfig([path]);
    expect(config.errors).toHaveLength(1);
    expect(config.hooks.map((h) => h.definition.name)).toEqual(["good"]);
  });
});

describe("malformed config does not disable everything else", () => {
  it("skips a null hook entry and keeps its neighbours", () => {
    // Regression: `{"hooks":[null]}` threw out of loadConfig, killed the whole
    // extension, and left the user with zero guardrails and no [pi-hooks] warning.
    const path = write("hooks.json", {
      hooks: [null, { name: "good", on: "tool_call", action: { type: "block" } }],
    });
    const config = loadConfig([path]);
    expect(config.hooks.map((h) => h.definition.name)).toEqual(["good"]);
    expect(config.errors[0]).toContain("expected a hook object");
  });

  it("reports a non-array extends instead of iterating a string per character", () => {
    const path = write("hooks.json", { extends: "preset:secrets", hooks: [] });
    const config = loadConfig([path]);
    expect(config.errors).toHaveLength(1);
    expect(config.errors[0]).toContain('"extends" must be an array');
  });

  it("reports a non-string extends entry", () => {
    const path = write("hooks.json", { extends: [5], hooks: [] });
    expect(loadConfig([path]).errors[0]).toContain('every "extends" entry must be a string');
  });

  it("rejects a non-string matcher pattern at load time", () => {
    // Otherwise matchPattern throws `pattern.startsWith is not a function` on Pi's
    // hot path, and the model receives that as the tool result.
    const path = write("hooks.json", {
      hooks: [{ name: "bad", on: "tool_call", match: { tool: 123 }, action: { type: "block" } }],
    });
    const config = loadConfig([path]);
    expect(config.hooks).toHaveLength(0);
    expect(config.errors[0]).toContain('"match.tool" must be a string');
  });

  it("rejects a non-string pattern nested in input, all, any, and not", () => {
    const cases: [string, unknown][] = [
      ["match.input.path", { input: { path: null } }],
      ["match.all[0].tool", { all: [{ tool: 1 }] }],
      ["match.any[0].tool", { any: [{ tool: 1 }] }],
      ["match.not.tool", { not: { tool: 1 } }],
    ];
    for (const [expected, match] of cases) {
      const errors = validateHook(
        { on: "tool_call", match, action: { type: "block" } } as never,
        "x",
      );
      expect(errors.join("\n"), expected).toContain(expected);
    }
  });

  it("accepts the matcher shapes the docs describe", () => {
    expect(
      validateHook(
        {
          on: "tool_call",
          match: {
            tool: ["write", "edit"],
            input: { path: ["**/*.ts", "!**/*.test.ts"] },
            isError: false,
            not: { input: { command: "/^git status/" } },
            any: [{ tool: "bash" }, { tool: "read" }],
          },
          action: { type: "block" },
        },
        "x",
      ),
    ).toEqual([]);
  });
});

describe("hooksForEvent", () => {
  it("selects hooks bound to the event, including array form", () => {
    const path = write("hooks.json", {
      hooks: [
        { name: "one", on: "tool_call", action: { type: "block" } },
        {
          name: "both",
          on: ["tool_call", "tool_result"],
          action: { type: "notify", message: "x" },
        },
        { name: "other", on: "tool_result", action: { type: "notify", message: "x" } },
      ],
    });
    const config = loadConfig([path]);
    expect(hooksForEvent(config, "tool_call").map((h) => h.definition.name)).toEqual([
      "one",
      "both",
    ]);
  });
});

describe("an AIR index placed at .pi/hooks.json", () => {
  it("loads through the normal config path", () => {
    write("hooks/guard/HOOK.json", { event: "pre_tool_call", command: "node", args: ["./g.mjs"] });
    const path = write("hooks.json", { guard: { description: "d", path: "hooks/guard" } });
    const config = loadConfig([path]);
    expect(config.errors).toEqual([]);
    expect(config.hooks.map((h) => h.definition.name)).toEqual(["@local/guard"]);
  });

  it("keeps the good entries when one has a typo, rather than dropping the file", () => {
    // Regression: requiring *every* entry to be well-formed let a single `pathh`
    // reclassify the index as the Pi-native format — which has no `hooks` array — so
    // it loaded zero hooks with zero errors and every guardrail vanished silently.
    write("hooks/guard/HOOK.json", { event: "pre_tool_call", command: "node", args: ["./g.mjs"] });
    const path = write("hooks.json", {
      guard: { description: "d", path: "hooks/guard" },
      typo: { description: "d", pathh: "hooks/other" },
    });
    const config = loadConfig([path]);
    expect(config.hooks.map((h) => h.definition.name)).toEqual(["@local/guard"]);
    expect(config.errors.join("\n")).toContain("typo");
  });
});

describe("listBuiltinAirHooks", () => {
  it("reports the AIR hooks shipped in the tarball", () => {
    expect(listBuiltinAirHooks()).toEqual([
      "block-dangerous-bash",
      "block-secret-access",
      "session-git-status",
    ]);
  });
});
