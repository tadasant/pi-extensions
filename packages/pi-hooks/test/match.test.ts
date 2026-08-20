import { describe, expect, it } from "vitest";
import { getPath, matches, matchPattern, matchPatterns, setPath } from "../src/match.ts";

describe("getPath / setPath", () => {
  it("digs into nested values by dot path", () => {
    expect(getPath({ a: { b: [1, 2] } }, "a.b.1")).toBe(2);
    expect(getPath({ a: 1 }, "a.b.c")).toBeUndefined();
    expect(getPath(undefined, "a")).toBeUndefined();
  });

  it("writes nested values, creating intermediates", () => {
    const target: Record<string, unknown> = {};
    setPath(target, "a.b.c", "x");
    expect(target).toEqual({ a: { b: { c: "x" } } });
  });

  it("replaces a non-object intermediate rather than throwing", () => {
    const target: Record<string, unknown> = { a: 5 };
    setPath(target, "a.b", 1);
    expect(target).toEqual({ a: { b: 1 } });
  });

  it("refuses to walk a prototype-polluting path", () => {
    // These paths arrive from a `patch-input` action's keys and from whatever JSON
    // a `command` hook printed — neither is fully trusted, and walking __proto__
    // would poison Object.prototype for the rest of the Pi process.
    for (const path of ["__proto__.polluted", "a.constructor.x", "a.prototype.x"]) {
      expect(() => setPath({}, path, "yes")).toThrow(/unsafe path segment/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reads through a prototype-polluting path as undefined", () => {
    expect(getPath({ a: 1 }, "__proto__")).toBeUndefined();
    expect(getPath({ a: 1 }, "a.constructor.name")).toBeUndefined();
  });
});

describe("matchPattern", () => {
  it("treats /.../ as a regular expression", () => {
    expect(matchPattern("rm -rf /", "/rm\\s+-rf/")).toBe(true);
    expect(matchPattern("ls", "/rm\\s+-rf/")).toBe(false);
  });

  it("honours regex flags", () => {
    expect(matchPattern("DROP TABLE x", "/drop table/i")).toBe(true);
    expect(matchPattern("DROP TABLE x", "/drop table/")).toBe(false);
  });

  it("matches globs, with ** crossing separators and * not", () => {
    expect(matchPattern("src/app/.env", "**/.env")).toBe(true);
    expect(matchPattern(".env", "**/.env")).toBe(true);
    expect(matchPattern("src/a.ts", "*.ts")).toBe(false);
    expect(matchPattern("a.ts", "*.ts")).toBe(true);
  });

  it("supports brace alternation", () => {
    expect(matchPattern("a.yml", "*.{yml,yaml}")).toBe(true);
    expect(matchPattern("a.json", "*.{yml,yaml}")).toBe(false);
  });

  it("negates with a leading !", () => {
    expect(matchPattern("a.ts", "!*.ts")).toBe(false);
    expect(matchPattern("a.js", "!*.ts")).toBe(true);
  });

  it("does not match a missing value", () => {
    expect(matchPattern(undefined, "*")).toBe(false);
  });

  it("falls back to glob matching when a regex-looking pattern will not compile", () => {
    // `/etc/sys` looks like a regex — trailing segment is all [gimsuy] — but the
    // duplicate "s" flag makes the constructor throw. Treating it as the literal
    // path the user obviously meant beats silently never matching.
    expect(matchPattern("/etc/sys", "/etc/sys")).toBe(true);
    expect(matchPattern("/proc/sys", "/proc/sys")).toBe(true);
    expect(matchPattern("/etc/other", "/etc/sys")).toBe(false);
  });

  it("survives a malformed regex instead of throwing", () => {
    expect(() => matchPattern("x", "/[unterminated/")).not.toThrow();
  });
});

describe("matchPatterns", () => {
  it("ORs positive patterns", () => {
    expect(matchPatterns("write", ["read", "write"])).toBe(true);
    expect(matchPatterns("bash", ["read", "write"])).toBe(false);
  });

  it("ANDs negative patterns against the positives", () => {
    const patterns = ["**/.env", "**/.env.*", "!**/.env.example"];
    expect(matchPatterns("app/.env", patterns)).toBe(true);
    expect(matchPatterns("app/.env.local", patterns)).toBe(true);
    expect(matchPatterns("app/.env.example", patterns)).toBe(false);
  });

  it("treats a list of only negatives as an allow-unless rule", () => {
    expect(matchPatterns("a.ts", ["!*.js"])).toBe(true);
    expect(matchPatterns("a.js", ["!*.js"])).toBe(false);
  });
});

describe("matches", () => {
  const subject = {
    toolName: "write",
    input: { path: "src/.env", content: "SECRET=1" },
    isError: false,
  };

  it("matches an empty matcher", () => {
    expect(matches(undefined, subject)).toBe(true);
    expect(matches({}, subject)).toBe(true);
  });

  it("ANDs the top-level fields", () => {
    expect(matches({ tool: "write", input: { path: "**/.env" } }, subject)).toBe(true);
    expect(matches({ tool: "read", input: { path: "**/.env" } }, subject)).toBe(false);
    expect(matches({ tool: "write", input: { path: "**/*.ts" } }, subject)).toBe(false);
  });

  it("compares isError strictly", () => {
    expect(matches({ isError: false }, subject)).toBe(true);
    expect(matches({ isError: true }, subject)).toBe(false);
  });

  it("supports all / any / not", () => {
    expect(matches({ any: [{ tool: "read" }, { tool: "write" }] }, subject)).toBe(true);
    expect(matches({ all: [{ tool: "write" }, { input: { path: "**/.env" } }] }, subject)).toBe(
      true,
    );
    expect(matches({ not: { tool: "write" } }, subject)).toBe(false);
    expect(matches({ not: { tool: "read" } }, subject)).toBe(true);
  });

  it("does not match when the input path is absent", () => {
    expect(matches({ input: { nope: "*" } }, subject)).toBe(false);
  });
});
