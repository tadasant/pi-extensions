#!/usr/bin/env node
/**
 * Materialize `@tadasant/pi-hooks` inside a dependent package's own `node_modules`.
 *
 * Pi requires one pi package that ships another to *bundle* it and reference its
 * resources through a `node_modules/` path (docs/packages.md), because packages are
 * installed with separate module roots. npm only bundles what is physically present
 * in the package's own `node_modules` at pack time — and in a workspace, npm hoists
 * the dependency to the repo root instead, which would silently publish a tarball
 * whose extension path does not exist.
 *
 * So: pack pi-hooks, extract it into the dependent's own node_modules, and let
 * `bundledDependencies` pick it up. Wired as the dependent's `prepack`, and run by
 * the e2e global setup so tests exercise the same layout users install.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_DIR = join(root, "packages", "pi-hooks");

/** Packages that bundle the hooks engine. */
export const BUNDLING_PACKAGES = ["packages/pi-plugins"];

export function prepareBundledDeps({ log = console.log, only } = {}) {
  const hooksPkg = JSON.parse(readFileSync(join(HOOKS_DIR, "package.json"), "utf8"));
  const targets = only ? [only] : BUNDLING_PACKAGES;
  const staging = mkdtempSync(join(tmpdir(), "pi-hooks-pack-"));
  const prepared = [];

  try {
    // When this runs as `prepack` under `npm publish --dry-run`, npm exports
    // `npm_config_dry_run=true`, which the nested pack would inherit and then write
    // no tarball at all. Scrub it, and say so explicitly.
    const { npm_config_dry_run, ...env } = process.env;
    execFileSync(
      "npm",
      ["pack", "--pack-destination", staging, "--dry-run=false", "--loglevel=error"],
      { cwd: HOOKS_DIR, env, stdio: ["ignore", "ignore", "inherit"] },
    );
    const tarball = readdirSync(staging).find((name) => name.endsWith(".tgz"));
    if (!tarball)
      throw new Error(`npm pack produced no tarball for ${hooksPkg.name} in ${staging}`);

    for (const relative of targets) {
      const pkgDir = join(root, relative);
      const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
      const required = pkg.dependencies?.[hooksPkg.name];
      if (required !== hooksPkg.version) {
        throw new Error(
          `${pkg.name} depends on ${hooksPkg.name}@${required}, but that package is at ` +
            `${hooksPkg.version}. The bundled dependency must be pinned to the exact sibling version.`,
        );
      }
      const target = join(pkgDir, "node_modules", "@tadasant", "pi-hooks");
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      // --strip-components=1 drops the tarball's `package/` prefix.
      execFileSync("tar", ["-xzf", join(staging, tarball), "-C", target, "--strip-components=1"]);
      const entry = join(target, "extensions", "hooks.ts");
      if (!existsSync(entry)) throw new Error(`Bundle prepared but ${entry} is missing`);
      log(`Bundled ${hooksPkg.name}@${hooksPkg.version} into ${target}`);
      prepared.push(target);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return prepared;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareBundledDeps();
}
