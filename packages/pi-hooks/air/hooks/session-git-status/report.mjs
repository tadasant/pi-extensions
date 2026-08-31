#!/usr/bin/env node
/**
 * AIR hook: report the repository's state at session start.
 *
 * Advisory only — it exits 0 even outside a repository, so it never blocks anything.
 */
import { execFileSync } from "node:child_process";
import { readEvent } from "../lib/hook.mjs";

await readEvent();
try {
  const status = execFileSync("git", ["status", "--short", "--branch"], { encoding: "utf8" });
  const lines = status.split("\n").slice(0, 20).join("\n").trim();
  if (lines) console.log(`Repository state at session start:\n${lines}`);
} catch {
  // Not a git repository, or git is unavailable. Nothing to report.
}
