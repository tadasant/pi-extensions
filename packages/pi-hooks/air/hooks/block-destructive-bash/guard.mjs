#!/usr/bin/env node
/** AIR hook: refuse the bash commands an agent should never run unsupervised. */
import { block, readEvent } from "../lib/hook.mjs";

const { input = {} } = await readEvent();
const command = String(input.command ?? "");

// A recursive delete of a root needs *both* a recursive and a force flag, in either
// order, clustered (-rf, -fr) or separate (-r -f), short or long.
const recursive = /(?:^|\s)(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)/;
const force = /(?:^|\s)(?:-[a-zA-Z]*[fF][a-zA-Z]*|--force)(?=\s|$)/;
const rootTarget = /\s["']?(\/\*?|~|\$HOME|\.{1,2}\/?|\*)["']?\s*($|[|;&])/;
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
if (/(curl|wget)\s[^|\n]*\|\s*(sudo\s+)?(ba|z|k|)sh\b/.test(command)) {
  block(
    "piping a download straight into a shell executes unreviewed code. Download it, read it, then run it.",
  );
}
if (/(^|[|;&\n])\s*sudo\s/m.test(command)) {
  block(
    "sudo escalates outside the workspace. Ask the user to run this themselves if it is genuinely needed.",
  );
}
if (/(DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE|db:drop|drop-database)/i.test(command)) {
  block(
    "destructive database statements are blocked. Run them yourself against a database you have a backup of.",
  );
}
