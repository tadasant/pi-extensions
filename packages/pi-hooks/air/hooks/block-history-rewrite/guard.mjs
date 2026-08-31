#!/usr/bin/env node
/** AIR hook: refuse git commands that irreversibly discard uncommitted work. */
import { block, readEvent } from "../lib/hook.mjs";

const { input = {} } = await readEvent();
const command = String(input.command ?? "");
const GIT = String.raw`git\s+(?:-[^\s]+\s+(?:[^-\s][^\s]*\s+)?)*`;
const destructive = String.raw`(reset\s+--hard|clean\s+-[a-z]*[fd]|checkout\s+--\s+\.|restore\s+--staged\s+--worktree)`;

if (new RegExp(`${GIT}${destructive}`).test(command)) {
  block(`\`${command}\` throws away uncommitted work irreversibly. Commit or stash first.`);
}
