#!/usr/bin/env node
/**
 * Guards a tag-triggered release: `v0.1.0` must match the version every publishable
 * workspace declares. Without this, a mistyped tag would publish the previous
 * version's contents under a new name in the changelog and nowhere else.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISHABLE } from "./packages.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2];
if (!tag) {
  console.error("usage: check-release-tag.mjs <tag>");
  process.exit(1);
}
const expected = tag.replace(/^v/, "");
let failed = false;

for (const dir of PUBLISHABLE) {
  const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
  if (pkg.version !== expected) {
    console.error(`${pkg.name} is at ${pkg.version}, but the tag says ${expected}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`Tag ${tag} matches all package versions.`);
