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

/**
 * Every resource the package's `pi` manifest promises.
 *
 * Extensions are exact file paths, so they must appear verbatim in the tarball.
 * Skills, prompts, and themes are directories, so require at least one shipped file
 * under each — an empty declared directory is the same broken promise.
 */
function manifestExpectations(pkg) {
  const pi = pkg.pi ?? {};
  const clean = (entry) => entry.replace(/^\.\//, "").replace(/\/$/, "");
  return {
    files: (pi.extensions ?? []).map(clean),
    directories: [...(pi.skills ?? []), ...(pi.prompts ?? []), ...(pi.themes ?? [])].map(clean),
  };
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
    if (!tarball) throw new Error(`npm pack produced no tarball for ${pkg.name} in ${staging}`);
    const entries = execFileSync("tar", ["-tzf", join(staging, tarball)], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.replace(/^package\//, "").trim())
      .filter(Boolean);

    const { files, directories } = manifestExpectations(pkg);
    for (const promised of files) {
      if (!entries.includes(promised)) {
        console.error(`  MISSING: package.json "pi" manifest points at ${promised}`);
        failed = true;
      } else {
        console.log(`  ok: ${promised}`);
      }
    }
    for (const promised of directories) {
      const shipped = entries.filter((entry) => entry.startsWith(`${promised}/`));
      if (shipped.length === 0) {
        console.error(
          `  MISSING: package.json "pi" manifest declares ${promised}/ but it is empty`,
        );
        failed = true;
      } else {
        console.log(`  ok: ${promised}/ (${shipped.length} files)`);
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
