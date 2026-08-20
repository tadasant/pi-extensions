#!/usr/bin/env node
/**
 * `npm publish --dry-run` for every publishable workspace, plus assertions that the
 * resulting tarballs actually contain what a Pi user needs.
 *
 * This is the part of the release path that can be proven without an npm credential:
 * it exercises `prepack`, resolves the `files` allowlist, and fails if a manifest
 * promises a resource the tarball does not carry.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISHABLE } from "./packages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failed = false;

/** Every path the package's `pi` manifest promises must exist in the tarball. */
function manifestPaths(pkg) {
  const pi = pkg.pi ?? {};
  return [...(pi.extensions ?? [])].map((entry) => entry.replace(/^\.\//, ""));
}

for (const dir of PUBLISHABLE) {
  const pkgDir = join(root, dir);
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  console.log(`\n=== ${pkg.name}@${pkg.version} ===`);

  // Inherit both streams: npm writes the tarball contents listing to stderr, and
  // that listing is the evidence a reader wants out of a dry run.
  execFileSync("npm", ["publish", "--dry-run", "--access", "public"], {
    cwd: pkgDir,
    stdio: ["ignore", "inherit", "inherit"],
  });

  // Pack for real so the contents can be inspected, not just described.
  const staging = mkdtempSync(join(tmpdir(), "pi-pack-"));
  try {
    execFileSync("npm", ["pack", "--pack-destination", staging, "--loglevel=error"], {
      cwd: pkgDir,
      stdio: ["ignore", "ignore", "inherit"],
    });
    const tarball = readdirSync(staging).find((name) => name.endsWith(".tgz"));
    const entries = execFileSync("tar", ["-tzf", join(staging, tarball)], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.replace(/^package\//, "").trim())
      .filter(Boolean);

    for (const promised of manifestPaths(pkg)) {
      if (!entries.includes(promised)) {
        console.error(`  MISSING: package.json "pi" manifest points at ${promised}`);
        failed = true;
      } else {
        console.log(`  ok: ${promised}`);
      }
    }
    if (!entries.includes("README.md")) {
      console.error("  MISSING: README.md");
      failed = true;
    }
    if (!entries.includes("LICENSE")) {
      console.error("  MISSING: LICENSE");
      failed = true;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (failed) {
  console.error("\nPublish dry run failed: at least one tarball is missing promised contents.");
  process.exit(1);
}
console.log("\nAll publishable packages produced complete tarballs.");
console.log("Publishing itself is gated on the NPM_TOKEN repository secret.");
