import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  discoverConfigPaths,
  hooksForEvent,
  listPresets,
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
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

describe("stripJsonComments", () => {
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
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "hooks.json"), "{}");
    const paths = discoverConfigPaths({ cwd: dir, agentDir: join(dir, "missing-agent"), env: {} });
    expect(paths).toEqual([join(projectDir, "hooks.json")]);
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

  it("resolves preset: references to the bundled presets", () => {
    const path = write("hooks.json", { extends: ["preset:secrets"] });
    const config = loadConfig([path]);
    expect(config.errors).toEqual([]);
    expect(config.hooks.length).toBeGreaterThan(0);
    expect(config.hooks.every((h) => h.source.endsWith("secrets.json"))).toBe(true);
  });

  it("reports an unknown preset without throwing", () => {
    const path = write("hooks.json", { extends: ["preset:nope"] });
    expect(loadConfig([path]).errors[0]).toContain('Unknown preset "nope"');
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

describe("listPresets", () => {
  it("reports the presets shipped in the tarball", () => {
    expect(listPresets()).toEqual(
      expect.arrayContaining(["secrets", "git-guard", "destructive-bash"]),
    );
  });
});
