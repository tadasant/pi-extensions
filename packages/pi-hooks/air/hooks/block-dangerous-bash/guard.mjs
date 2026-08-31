#!/usr/bin/env node
/**
 * AIR hook: refuse the shell commands an agent should never run unsupervised.
 *
 * The three concerns here — irreversible deletes, unreviewed code execution, and
 * history rewrites — are one hook rather than three because every AIR hook is a
 * process spawn on Pi's hot path, and all three are scoped to the same `bash` tool
 * and the same event. Fork the file if you want only some of the rules.
 */
import { block, readEvent } from "../lib/hook.mjs";

const { input = {} } = await readEvent();
const command = String(input.command ?? "");

/** `git`, tolerating global options and their values: `git -C <dir> push`. */
const GIT = String.raw`git\s+(?:-[^\s]+\s+(?:[^-\s][^\s]*\s+)?)*`;

// --- Irreversible deletes ------------------------------------------------------
// A recursive delete of a root needs *both* a recursive and a force flag, in either
// order, clustered (-rf, -fr) or separate (-r -f), short or long.
const recursive = /(?:^|\s)(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)/;
const force = /(?:^|\s)(?:-[a-zA-Z]*[fF][a-zA-Z]*|--force)(?=\s|$)/;
// Each target may carry a trailing slash and/or a glob: `~/`, `./*`, `/`, `../..`.
const root = String.raw`(?:/|~|\$HOME|\.{1,2})(?:/\.{1,2})*/?\*?|\*`;
const rootTarget = new RegExp(String.raw`\s["']?(?:${root})["']?\s*($|[|;&])`);
if (
  /\brm\s/.test(command) &&
  recursive.test(command) &&
  force.test(command) &&
  rootTarget.test(command)
) {
  block(
    `\`${command}\` would recursively delete a root, the home directory, or the whole working tree.`,
  );
}

// --- Unreviewed code execution -------------------------------------------------
if (/(curl|wget)\s[^|\n]*\|\s*(sudo\s+)?(\/\w+\/)?(ba|z|k|)sh\b/.test(command)) {
  block(
    "piping a download straight into a shell executes unreviewed code. Download it, read it, then run it.",
  );
}
if (/\b(ba|z|k|)sh\s+<\(\s*(curl|wget)\b/.test(command)) {
  block(
    "process-substituting a download into a shell executes unreviewed code. Download it, read it, then run it.",
  );
}
if (/(^|[|;&(`\n]|\$\()\s*sudo\s/m.test(command)) {
  block(
    "sudo escalates outside the workspace. Ask the user to run this themselves if it is genuinely needed.",
  );
}

// --- Git history rewrites ------------------------------------------------------
const destructive = [
  String.raw`reset\s+--hard`,
  String.raw`clean\s+(?:-[a-z]*[fd]|--force|--\S*)`,
  String.raw`checkout\s+(?:--force\s+|-f\s+)?(?:--\s+)?\.(?:\s|$)`,
  String.raw`restore\s+(?:[^\s]+\s+)*\.(?:\s|$)`,
].join("|");
if (new RegExp(`${GIT}(?:${destructive})`).test(command)) {
  block(
    `\`${command}\` throws away uncommitted work irreversibly. Commit or stash first, then re-run.`,
  );
}

// --- Git pushes that lose other people's work ----------------------------------
// `-f` is the common spelling and was the one most worth catching.
const forcePush = new RegExp(
  `${GIT}push\\b[^&|;\\n]*(?:--force(?!-with-lease)|(?:^|\\s)-[a-zA-Z]*f[a-zA-Z]*(?=\\s|$))`,
);
if (forcePush.test(command) && !/--force-with-lease/.test(command)) {
  block(
    "plain `git push --force` discards work you cannot see. Use --force-with-lease, or push without force.",
  );
}
// A refspec may be `main`, `HEAD:main`, or `+main` (force-by-refspec).
if (new RegExp(`${GIT}push\\b[^&|;\\n]*[\\s:+](main|master|HEAD)(\\s|$|:)`).test(command)) {
  block(
    "pushing straight to main/master is not allowed. Open a pull request from a feature branch instead.",
  );
}

// --- Destructive SQL -----------------------------------------------------------
if (/(DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE|db:drop|drop-database)/i.test(command)) {
  block(
    "destructive database statements are blocked. Run them yourself against a database you have a backup of.",
  );
}
