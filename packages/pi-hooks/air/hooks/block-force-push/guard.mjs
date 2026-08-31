#!/usr/bin/env node
/** AIR hook: refuse unsafe force pushes and pushes aimed at a default branch. */
import { block, readEvent } from "../lib/hook.mjs";

const { input = {} } = await readEvent();
const command = String(input.command ?? "");
// Tolerate git's global options (`git -C <dir> push`, `git --git-dir=<x> push`).
const GIT = String.raw`git\s+(?:-[^\s]+\s+(?:[^-\s][^\s]*\s+)?)*`;

if (new RegExp(`${GIT}push\\b[^&|;\\n]*--force(?!-with-lease)`).test(command)) {
  block("plain `git push --force` discards work you cannot see. Use --force-with-lease.");
}
if (new RegExp(`${GIT}push\\b[^&|;\\n]*\\s(main|master|HEAD)(\\s|$)`).test(command)) {
  block(
    "pushing straight to main/master is not allowed. Open a pull request from a feature branch.",
  );
}
