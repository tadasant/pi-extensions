/**
 * Downloads the pinned Pi CLI once, before any e2e test runs, and asserts the
 * binary reports exactly the pinned version. If that assertion ever fails, the
 * suite is not testing what it claims to test.
 */
import { execFileSync } from "node:child_process";
import { installPinnedPi, PI_CLI_ENTRY, PI_VERSION } from "../../scripts/install-pinned-pi.mjs";
import { prepareStarterBundle } from "../../scripts/prepare-starter-bundle.mjs";

export default function setup(): void {
  installPinnedPi();
  // npm hoists workspace dependencies, so the starter's bundled copy of the hooks
  // engine only exists once it is materialized. Do it here so the e2e suite drives
  // the same on-disk layout a published tarball produces.
  prepareStarterBundle();
  const reported = execFileSync(process.execPath, [PI_CLI_ENTRY, "--version"], {
    encoding: "utf8",
    env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
  }).trim();
  if (!reported.includes(PI_VERSION)) {
    throw new Error(`Expected pinned Pi ${PI_VERSION}, but the binary reports "${reported}"`);
  }
  console.log(`[e2e] driving real Pi ${reported} from ${PI_CLI_ENTRY}`);
}
