/**
 * Shared helpers for the AIR hooks this package ships.
 *
 * pi-hooks delivers the event as JSON on stdin and as `PI_HOOK_*` variables, and
 * treats a non-zero exit as a block with stderr as the reason.
 */
import { writeSync } from "node:fs";

/**
 * The full event, from stdin.
 *
 * A guard that cannot read the event refuses rather than waving the call through:
 * failing open would silently disable the guardrail on exactly the malformed input
 * most likely to be interesting.
 */
export async function readEvent() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  // Concat first: joining Buffers decodes each independently, so a UTF-8 sequence
  // straddling a read boundary would become replacement characters and break JSON.
  const raw = Buffer.concat(chunks.map((c) => Buffer.from(c)))
    .toString("utf8")
    .trim();
  const source = raw || process.env.PI_HOOK_PAYLOAD || "";
  if (!source) block("could not read the hook event (empty stdin)");
  try {
    return JSON.parse(source);
  } catch (error) {
    block(`could not parse the hook event: ${error.message}`);
  }
}

/** The hook's merged `x-config`, as an object. */
export function config() {
  try {
    return JSON.parse(process.env.AIR_HOOK_CONFIG ?? "{}");
  } catch {
    return {};
  }
}

/** Refuse the event: stderr becomes the reason the model is shown. */
export function block(reason) {
  // writeSync, not console.error: stderr is async for pipes, and process.exit can
  // truncate or drop a long reason, leaving the model with nothing.
  writeSync(2, `pi-hooks: ${reason}\n`);
  process.exit(1);
}

/** The project directory, as opposed to the hook's own. */
export function projectDir() {
  return process.env.PI_HOOK_CWD || process.cwd();
}
