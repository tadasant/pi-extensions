import { getPath } from "./match.ts";

/** POSIX single-quote escaping, so a templated value cannot break out of `sh -c`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

/**
 * Expand `{{dot.path}}` references against a context object.
 *
 * When `quote` is set (string commands run through a shell), every interpolated
 * value is shell-quoted. Argv commands pass values through raw, since there is no
 * shell to confuse.
 */
export function renderTemplate(
  template: string,
  context: unknown,
  options: { quote?: boolean } = {},
): string {
  return template.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_full, path: string) => {
    const rendered = stringify(getPath(context, path));
    return options.quote ? shellQuote(rendered) : rendered;
  });
}

/** Recursively template every string inside a JSON-ish value. */
export function renderDeep(value: unknown, context: unknown): unknown {
  if (typeof value === "string") return renderTemplate(value, context);
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, context));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = renderDeep(nested, context);
    }
    return out;
  }
  return value;
}
