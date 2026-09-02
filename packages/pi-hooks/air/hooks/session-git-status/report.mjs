#!/usr/bin/env node
/**
 * AIR hook: report the repository's state at session start.
 *
 * Advisory — it exits 0 even outside a repository, so it never blocks anything.
 */
import { execFileSync } from "node:child_process";
import { projectDir, readEvent } from "../lib/hook.mjs";

await readEvent();
try {
  // -C the project directory: an AIR hook runs from its *own* directory, which once
  // installed lives under node_modules and is not the user's repository.
  const status = execFileSync("git", ["-C", projectDir(), "status", "--short", "--branch"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const lines = status.split("\n").slice(0, 20).join("\n").trim();
  if (lines) {
    // A control object on stdout is how a hook surfaces something to the user; plain
    // stdout from a zero-exit hook is discarded by the runner.
    process.stdout.write(
      JSON.stringify({ notify: `Repository state at session start:\n${lines}` }),
    );
  }
} catch {
  // Not a git repository, or git is unavailable. Nothing to report.
}
