# @tadasant/pi-hooks

**Declarative hooks for the [Pi coding agent](https://github.com/earendil-works/pi).**
Map Pi lifecycle events to actions in a JSON file — no TypeScript required.

```bash
pi install npm:@tadasant/pi-hooks
```

## Why this exists

Pi already ships a first-class [extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md):
subscribe to `tool_call`, return `{ block: true }`, done. That is the *primitive*.
What Pi does not ship is the layer above it — a way to express "refuse writes to
`.env`" as configuration rather than as a TypeScript module you write, install, and
maintain. Claude Code has that layer. Pi has no `hooks` concept anywhere in its docs.

This package is that layer, built entirely on Pi's public extension API.

## Quick start

Create `.pi/hooks.json` in your project:

```json
{
  "$schema": "https://raw.githubusercontent.com/tadasant/pi-extensions/main/packages/pi-hooks/schema/hooks.schema.json",
  "extends": ["preset:secrets", "preset:git-guard"],
  "hooks": [
    {
      "name": "no-migrations-without-review",
      "on": "tool_call",
      "match": { "tool": ["write", "edit"], "input": { "path": "db/migrate/**" } },
      "action": {
        "type": "block",
        "reason": "Migrations are reviewed by a human before they are written."
      }
    }
  ]
}
```

Run `/hooks` inside Pi to see what loaded, and `/hooks reload` after editing.

## Where config is read from

Lowest precedence first — every file found is merged:

| Location | Scope |
|---|---|
| `$PI_CODING_AGENT_DIR/hooks.json` (default `~/.pi/agent/hooks.json`) | All projects |
| `.pi/hooks.json` in the working directory | This project |

`hooks.jsonc` is accepted at both locations, and `//` and `/* */` comments are
allowed in either extension. Setting `PI_HOOKS_CONFIG` to a colon-separated list of
paths replaces discovery entirely.

## Events

| Event | Fires | Can |
|---|---|---|
| `session_start` | Session started, resumed, or forked | notify, run a command |
| `session_shutdown` | Session torn down | notify, run a command |
| `user_prompt` | Raw user input, before skill/template expansion | block the prompt |
| `before_agent_start` | Prompt submitted, before the agent loop | inject context |
| `tool_call` | Before a tool runs | **block**, **rewrite the input** |
| `tool_result` | After a tool runs | **rewrite the result** |
| `user_bash` | User ran `!cmd` | block |
| `agent_settled` | Agent finished with nothing queued | notify, run a command |

## Matching

`match` fields are ANDed. A field's value may be one pattern or a list.

```json
{
  "tool": ["write", "edit"],
  "input": { "path": ["src/**/*.ts", "!**/*.test.ts"] },
  "not": { "input": { "command": "/^git status/" } }
}
```

- **Globs**: `*` stays inside a path segment, `**` crosses them, `{a,b}` alternates.
- **Regex**: any pattern written as `/expr/flags`.
- **Negation**: a leading `!`. Within a list, positives are ORed and negatives are
  ANDed — so `["**/.env*", "!**/.env.example"]` reads the way it looks.
- **Combinators**: `all`, `any`, `not` nest arbitrarily.
- `input` paths are dot paths into the tool's arguments (`input.path`, `input.command`).

## Actions

### `block`

```json
{ "type": "block", "reason": "Not that file.", "terminate": false }
```

The reason is handed to the model as the tool result, so write it as an instruction
the model can act on. `terminate: true` asks Pi to stop the agent loop rather than
let the model retry.

### `patch-input`

Rewrites the tool arguments Pi is about to execute.

```json
{ "type": "patch-input", "set": { "command": "set -o pipefail\n{{input.command}}" } }
```

### `command`

Runs a shell command. The full event arrives as JSON on stdin and as `PI_HOOK_*`
environment variables, so a hook script never needs templating:

| Variable | Contents |
|---|---|
| `PI_HOOK_EVENT` | `tool_call`, `tool_result`, … |
| `PI_HOOK_TOOL` | Tool name |
| `PI_HOOK_INPUT` | Tool arguments, as JSON |
| `PI_HOOK_PROMPT` | User prompt, where the event has one |
| `PI_HOOK_PAYLOAD` | The whole event, as JSON |

Exit `0` and the call proceeds. Exit non-zero and the call is blocked, with stderr
as the reason — set `"blockOnFailure": false` for an advisory hook that only logs.

For finer control, print a JSON object on stdout:

```json
{ "block": true, "reason": "…", "terminate": false,
  "patchInput": { "command": "…" }, "content": "…", "context": "…", "notify": "…" }
```

Use `"command"` for a shell string (interpolated `{{…}}` values are shell-quoted, so
a filename with a quote in it cannot break out) or `"argv"` for an argv array run
with no shell at all. `timeoutMs` defaults to 30s; a hook that hangs is killed and
does not stall the agent past its own timeout.

### `notify` and `context`

```json
{ "type": "notify", "message": "Hooks are live", "level": "info" }
{ "type": "context", "text": "House style: no default exports." }
```

`context` applies to `before_agent_start` and injects a message into the conversation.

## Bundled presets

`extends` pulls in curated configs shipped inside this package:

| Preset | What it stops |
|---|---|
| `preset:secrets` | Reading or writing `.env`, private keys, `.netrc`, service-account JSON; catting them out through bash. `.env.example` is exempt. |
| `preset:git-guard` | `git push --force` without `--force-with-lease`, pushes straight to `main`/`master`, `git reset --hard`, `git clean -fd`. |
| `preset:destructive-bash` | `rm -rf` of `/`, `~`, or the whole working tree; `curl … \| sh`; `sudo`; `DROP DATABASE`/`TRUNCATE`. |
| `preset:bash-hardening` | Not a block — prepends `set -o pipefail` to bash commands that do not set their own options. |
| `preset:session-context` | Not a block — injects `git status` into the first turn of a session. |

`extends` also accepts a relative path or a Node-resolvable specifier
(`@scope/pkg/presets/x.json`), so a team can publish its own policy pack.

## Hook ordering and errors

Hooks run in load order — extended configs first, then the file's own. The first
hook that blocks wins and the rest are skipped for that event. A hook that throws is
logged to stderr and the event continues, unless it sets `"continueOnError": false`.
A malformed hook is reported by name at startup and skipped; it never takes the
session down.

## Security

Hooks execute arbitrary commands with your permissions, exactly like the extensions
they are built on. Treat a `hooks.json` from someone else the way you would treat a
shell script from someone else. The blocking presets are a guardrail against an agent
making a mistake, not a sandbox against an adversary.

## License

[MIT](LICENSE)
