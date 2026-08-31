#!/usr/bin/env node
/**
 * AIR hook: refuse to read, write, or print secret material.
 *
 * The event arrives as JSON on stdin (and in PI_HOOK_* variables). A non-zero exit
 * blocks the tool call, with stderr as the reason the model is given.
 */
import { block, config, readEvent } from "../lib/hook.mjs";

const event = await readEvent();
const { toolName, input = {} } = event;
const secret = new RegExp(
  config().secretPaths ??
    String.raw`\.env($|\.)|\.pem$|\.p12$|\.pfx$|id_rsa|id_ed25519|\.npmrc$|\.netrc$|credentials$|serviceaccount.*\.json$`,
);
const allow = new RegExp(config().allowPaths ?? String.raw`\.env\.(example|sample)$`);

if (["read", "write", "edit"].includes(toolName)) {
  const path = String(input.path ?? "");
  if (path && !allow.test(path) && secret.test(path)) {
    block(
      `refusing to touch ${path}. Secret material is edited by a human, not the agent. ` +
        "Ask the user to make this change.",
    );
  }
}

if (toolName === "bash") {
  const command = String(input.command ?? "");
  const exfiltrate =
    /(cat|less|more|head|tail|bat|xxd|base64)\s+[^|;&\n]*(\.env([.\s]|$)|id_rsa|id_ed25519|\.netrc|\.pem)/;
  if (exfiltrate.test(command)) {
    block(
      "that command would print secret material into the transcript. " +
        "Read the value from the environment at runtime instead.",
    );
  }
}
