#!/usr/bin/env node
/**
 * AIR hook: refuse to read, write, or print secret material.
 *
 * Both the file-tool and bash branches honour the same `x-config`, so a consumer
 * overlay of `secretPaths`/`allowPaths` changes the whole hook rather than half of it.
 */
import { block, config, readEvent } from "../lib/hook.mjs";

const DEFAULT_SECRET = String.raw`\.env($|\.)|\.pem$|\.p12$|\.pfx$|id_rsa|id_ed25519|\.npmrc$|\.netrc$|credentials$|serviceaccount.*\.json$`;
const DEFAULT_ALLOW = String.raw`\.env\.(example|sample)$`;

const { toolName, input = {} } = await readEvent();
const settings = config();
const secret = new RegExp(settings.secretPaths ?? DEFAULT_SECRET);
const allow = new RegExp(settings.allowPaths ?? DEFAULT_ALLOW);

/** A path is secret when it matches `secretPaths` and is not exempted. */
const isSecret = (candidate) =>
  Boolean(candidate) && !allow.test(candidate) && secret.test(candidate);

if (["read", "write", "edit"].includes(toolName)) {
  const path = String(input.path ?? "");
  if (isSecret(path)) {
    block(
      `refusing to touch ${path}. Secret material is edited by a human, not the agent. ` +
        "Ask the user to make this change.",
    );
  }
}

if (toolName === "bash") {
  const command = String(input.command ?? "");
  // Only commands that would *emit* file contents; `rm .env` is a different concern.
  const reader = /\b(cat|less|more|head|tail|bat|xxd|base64|strings|od|nl|grep|rg|cp|scp|curl)\b/;
  if (reader.test(command)) {
    // Check every path-like token against the same rules the file tools use.
    for (const token of command.split(/[\s"'|;&<>()]+/)) {
      if (isSecret(token)) {
        block(
          `that command would expose ${token}. Read the value from the environment at ` +
            "runtime instead of printing it into the transcript.",
        );
      }
    }
  }
}
