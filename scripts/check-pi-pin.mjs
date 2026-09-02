#!/usr/bin/env node
/**
 * Guards the Pi pin: the version the e2e suite downloads must equal the version the
 * repo typechecks against. Without this, `@earendil-works/pi-coding-agent` could be
 * bumped in package.json while the e2e suite kept exercising an older binary.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(root, "e2e/pi-version.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const declared = pkg.devDependencies?.[pin.package];

if (declared !== pin.version) {
  console.error(
    `Pi pin mismatch: e2e/pi-version.json says ${pin.version}, ` +
      `package.json devDependencies["${pin.package}"] says ${declared ?? "(absent)"}.\n` +
      "Both must be the same exact version, with no range prefix.",
  );
  process.exit(1);
}
if (/^[\^~><=*]/.test(pin.version)) {
  console.error(`Pi pin must be an exact version, got "${pin.version}".`);
  process.exit(1);
}
console.log(`Pi pin OK: ${pin.package}@${pin.version}`);
