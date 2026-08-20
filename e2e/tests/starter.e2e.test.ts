/**
 * End-to-end coverage for the starter bundle.
 *
 * `@tadasant/pi-starter` is an ordinary pi package: it bundles the hooks engine and
 * adds skills and prompt templates. These tests point the real Pi binary at the
 * package directory, which is the same code path `pi install npm:@tadasant/pi-starter`
 * takes, and check that Pi discovers each kind of resource the manifest declares.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, runPi, STARTER_PACKAGE_DIR, toolResults } from "../harness/pi.ts";

const manifest = JSON.parse(readFileSync(join(STARTER_PACKAGE_DIR, "package.json"), "utf8")) as {
  pi: { extensions: string[]; skills: string[]; prompts: string[] };
  dependencies: Record<string, string>;
  bundledDependencies: string[];
};

describe("starter package manifest", () => {
  it("declares the hooks engine as a bundled dependency", () => {
    // Pi's packages.md: another pi package must be bundled and referenced through
    // node_modules, not left as a bare dependency.
    expect(manifest.dependencies["@tadasant/pi-hooks"]).toBeDefined();
    expect(manifest.bundledDependencies).toContain("@tadasant/pi-hooks");
    expect(manifest.pi.extensions).toEqual(["node_modules/@tadasant/pi-hooks/extensions/hooks.ts"]);
  });

  it("ships the recommended hooks config it documents", () => {
    const recommended = JSON.parse(
      readFileSync(join(STARTER_PACKAGE_DIR, "hooks", "recommended.json"), "utf8"),
    ) as { extends: string[] };
    expect(recommended.extends).toEqual([
      "preset:secrets",
      "preset:git-guard",
      "preset:destructive-bash",
    ]);
  });
});

describe("starter resources inside a real Pi run", () => {
  it("loads the bundled hooks engine and enforces the recommended config", async () => {
    const result = await runPi({
      script: [
        { type: "tool", tool: "write", args: { path: ".env", content: "TOKEN=leaked" } },
        { type: "text", text: "understood" },
      ],
      prompt: "write the env file",
      // The starter's own recommended config, verbatim.
      hooksConfig: readFileSync(join(STARTER_PACKAGE_DIR, "hooks", "recommended.json"), "utf8"),
      extensions: [STARTER_PACKAGE_DIR],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const [call] = toolResults(result);
    expect(call?.isError).toBe(true);
    expect(call?.text).toContain("Secret material is edited by a human");
  });

  it("makes its skills and prompt templates available to Pi", async () => {
    const result = await runPi({
      script: [{ type: "text", text: "ok" }],
      prompt: "hello",
      extensions: [STARTER_PACKAGE_DIR],
      args: [
        "--skill",
        join(STARTER_PACKAGE_DIR, "skills", "verify-before-claiming-done.md"),
        "--skill",
        join(STARTER_PACKAGE_DIR, "skills", "scope-a-change.md"),
        "--prompt-template",
        join(STARTER_PACKAGE_DIR, "prompts", "review.md"),
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    // Pi injects loaded skills into the system prompt it sends upstream, so the
    // simulated model's request payload is the proof they were discovered.
    const payload = JSON.stringify(result.llm.requests);
    expect(payload).toContain("verify-before-claiming-done");
    expect(payload).toContain("scope-a-change");
  });
});

describe("repository hygiene", () => {
  it("keeps the published packages free of a floating Pi dependency", () => {
    for (const name of ["pi-hooks", "pi-starter"]) {
      const pkg = JSON.parse(
        readFileSync(join(REPO_ROOT, "packages", name, "package.json"), "utf8"),
      ) as Record<string, Record<string, string> | undefined>;
      // Pi's own packages are peer dependencies with a "*" range, per packages.md,
      // and must never be pulled in as a real runtime dependency.
      expect(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe("*");
      expect(pkg.dependencies?.["@earendil-works/pi-coding-agent"]).toBeUndefined();
    }
  });
});
