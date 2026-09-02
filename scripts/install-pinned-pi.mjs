#!/usr/bin/env node
/**
 * Download the pinned Pi CLI into `.e2e-cache/pi/<version>/`.
 *
 * This is a real npm install of the published tarball into an isolated prefix — the
 * e2e suite then drives that binary as a subprocess. Nothing about Pi is stubbed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(root, "e2e/pi-version.json"), "utf8"));

export const PI_PACKAGE = pin.package;
export const PI_VERSION = pin.version;
export const PI_INSTALL_DIR = join(root, ".e2e-cache", "pi", PI_VERSION);
export const PI_CLI_ENTRY = join(
  PI_INSTALL_DIR,
  "node_modules",
  ...PI_PACKAGE.split("/"),
  "dist",
  "cli.js",
);

/** Install the pinned Pi if it is not already cached. Returns the CLI entry path. */
export function installPinnedPi({ log = console.log } = {}) {
  if (existsSync(PI_CLI_ENTRY)) {
    log(`Pi ${PI_VERSION} already cached at ${PI_CLI_ENTRY}`);
    return PI_CLI_ENTRY;
  }
  mkdirSync(PI_INSTALL_DIR, { recursive: true });
  // A private, isolated package.json keeps this install from touching the workspace.
  writeFileSync(
    join(PI_INSTALL_DIR, "package.json"),
    `${JSON.stringify({ name: "pi-e2e-pinned", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  log(`Installing ${PI_PACKAGE}@${PI_VERSION} into ${PI_INSTALL_DIR} ...`);
  execFileSync(
    "npm",
    [
      "install",
      `${PI_PACKAGE}@${PI_VERSION}`,
      "--no-audit",
      "--no-fund",
      "--no-save",
      "--omit=dev",
      "--loglevel=error",
    ],
    { cwd: PI_INSTALL_DIR, stdio: "inherit" },
  );
  if (!existsSync(PI_CLI_ENTRY)) {
    throw new Error(`Pi install finished but ${PI_CLI_ENTRY} is missing`);
  }
  log(`Pi ${PI_VERSION} installed.`);
  return PI_CLI_ENTRY;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  installPinnedPi();
}
