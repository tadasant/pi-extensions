import { describe, expect, it } from "vitest";
import { renderDeep, renderTemplate, shellQuote } from "../src/template.ts";

const context = { input: { path: "a b.ts", command: "echo hi" }, toolName: "write" };

describe("renderTemplate", () => {
  it("expands dot paths", () => {
    expect(renderTemplate("file={{input.path}}", context)).toBe("file=a b.ts");
    expect(renderTemplate("{{ toolName }}", context)).toBe("write");
  });

  it("renders a missing path as an empty string", () => {
    expect(renderTemplate("[{{nope.here}}]", context)).toBe("[]");
  });

  it("JSON-encodes non-string values", () => {
    expect(renderTemplate("{{input}}", context)).toBe(JSON.stringify(context.input));
  });

  it("shell-quotes when asked, so a value cannot break out of sh -c", () => {
    const evil = { input: { path: "x'; rm -rf /; echo '" } };
    const rendered = renderTemplate("prettier {{input.path}}", evil, { quote: true });
    expect(rendered).toBe(`prettier 'x'\\''; rm -rf /; echo '\\'''`);
    expect(rendered.startsWith("prettier '")).toBe(true);
  });

  it("leaves unknown placeholder syntax alone", () => {
    expect(renderTemplate("{{ a b }}", context)).toBe("{{ a b }}");
  });
});

describe("shellQuote", () => {
  it("wraps and escapes single quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("renderDeep", () => {
  it("templates strings anywhere in a structure", () => {
    expect(renderDeep({ a: ["{{toolName}}", 3], b: { c: "{{input.path}}" } }, context)).toEqual({
      a: ["write", 3],
      b: { c: "a b.ts" },
    });
  });

  it("passes non-strings through untouched", () => {
    expect(renderDeep(42, context)).toBe(42);
    expect(renderDeep(null, context)).toBe(null);
  });
});
