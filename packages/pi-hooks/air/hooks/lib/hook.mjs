/**
 * Shared helpers for the AIR hooks this package ships.
 *
 * pi-hooks delivers the event as JSON on stdin and as `PI_HOOK_*` variables, and
 * treats a non-zero exit as a block with stderr as the reason. These three helpers
 * are all a guard needs.
 */

/** The full event, from stdin, falling back to `PI_HOOK_PAYLOAD`. */
export async function readEvent() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = chunks.join("").trim() || process.env.PI_HOOK_PAYLOAD || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    return {};
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
  console.error(`pi-hooks: ${reason}`);
  process.exit(1);
}
