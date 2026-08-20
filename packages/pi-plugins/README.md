# @tadasant/pi-plugins

**AIR plugin support for the [Pi coding agent](https://github.com/earendil-works/pi).**
Resolve an [AIR](https://github.com/pulsemcp/air) plugin and activate the skills and
hooks it bundles inside a real Pi session.

```bash
pi install npm:@tadasant/pi-plugins
```

## What an AIR plugin is, and why Pi needs this

[AIR](https://github.com/pulsemcp/air) is a vendor-neutral framework for AI artifacts.
It defines six artifact types — skills, references, MCP servers, plugins, roots, and
hooks — and a **plugin** is the compositional one: a manifest that bundles other
artifacts **by ID** rather than a directory of content.

```json
// plugins.json — a thin registry
{
  "code-quality": {
    "description": "Linting, formatting, and coding-standards skills",
    "path": "./code-quality",
    "default_in_roots": ["*"]
  }
}
```

```json
// code-quality/.plugin/plugin.json — the body
{
  "title": "Code Quality Suite",
  "version": "1.2.0",
  "skills": ["lint-fix", "format-check"],
  "mcp_servers": ["eslint-server"],
  "hooks": ["lint-pre-commit"]
}
```

Pi cannot consume any of that. Pi has its own package format for distributing *Pi*
extensions, which is how this package reaches you — but an AIR plugin is a different
artifact type from a different ecosystem, and nothing in Pi reads it. This package is
the **Pi adapter for AIR**, the same role `@pulsemcp/air-adapter-opencode` plays for
OpenCode.

## What it activates

| AIR artifact | How it reaches Pi |
|---|---|
| **skills** | Contributed through Pi's own `resources_discover` event as `skillPaths`. An AIR skill is a directory containing `SKILL.md`, which is exactly what Pi discovers, so they load like any other skill. |
| **hooks** | Each `HOOK.json` is translated into a [`@tadasant/pi-hooks`](https://www.npmjs.com/package/@tadasant/pi-hooks) definition and dispatched by that engine. This package bundles it, so there is no second install and no second hook path. |
| **MCP servers** | **Resolved and reported, never started** — see below. |

## Configuration

Point the adapter at an AIR config. Discovery, in order:

| Location | Notes |
|---|---|
| `$PI_PLUGINS_CONFIG` | Explicit path; replaces discovery entirely |
| `./air.json` | In Pi's working directory |
| `./.air/air.json` | |

Which plugins activate follows AIR's own rule — membership is declared on the
artifact via `default_in_roots`, where `"*"` means every root:

| Variable | Effect |
|---|---|
| `PI_PLUGINS` | Comma-separated plugin IDs. Overrides `default_in_roots` entirely. |
| `PI_PLUGINS_ROOT` | Activates plugins naming this root in `default_in_roots`. |

Run `/plugins` inside Pi to see what resolved, and `/plugins reload` after editing.

## Event mapping

AIR's lifecycle vocabulary is agent-agnostic and broader than Pi's surface:

| AIR event | Pi event |
|---|---|
| `session_start` | `session_start` |
| `session_end` | `session_shutdown` |
| `pre_tool_call` | `tool_call` (can block) |
| `post_tool_call` | `tool_result` |
| `user_prompt_submit` | `user_prompt` (can block) |
| `stop` | `agent_settled` |

Claude Code's PascalCase spellings (`SessionStart`, `PreToolUse`, …) are accepted as
identity mappings, matching AIR's own behaviour.

**`pre_commit`, `post_commit`, `subagent_stop`, `notification`, and `pre_compact` are
not activated.** Pi has no git-commit lifecycle, no subagent concept, and no
extension-visible notification event, and `pi-hooks` does not currently expose
compaction. A hook using one of those loads with a named warning rather than
silently never firing — visible on stderr and in `/plugins`.

An AIR `matcher` becomes a pi-hooks matcher over the fields Pi actually exposes (tool
name, `input.command`, `input.path`, prompt text). `command`/`args` become a pi-hooks
`argv` action run from the hook's own directory, so a relative `./notify.sh` resolves;
`env` values get `${VAR}` interpolation; `timeout_seconds` becomes `timeoutMs`. The
merged `x-config` and the hook's qualified ID are handed to the script as
`AIR_HOOK_CONFIG` and `AIR_HOOK_ID`.

## The MCP boundary

An AIR plugin can bundle MCP servers, and this package deliberately **does not start
them**. Pi's MCP support comes from
[`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter);
re-implementing MCP here would duplicate a solved problem and put two implementations
in one session.

Instead the adapter resolves each `mcp_servers` entry against the catalog's `mcp.json`
and reports it — on stderr at startup and in `/plugins`, marked *reported, not
started*. That is the seam: an MCP-capable extension can read those entries and do the
wiring, and nothing here pretends to have done it.

## Scope

Local (filesystem) catalogs only. AIR's remote catalog providers (`github://…`) are a
separate extension surface; a catalog, plugin, hook, or skill path that looks like a
provider URI produces a named warning telling you to clone it locally, rather than
being silently skipped.

## Composition

Plugins composing plugins works as AIR specifies: children expand depth-first, a
parent's direct declarations win over inherited ones, IDs are deduplicated, and
circular references are rejected by name at resolution time.

Degradation is deliberate throughout. A missing manifest, an unresolvable artifact ID,
a skill directory that does not exist, or one plugin that fails to resolve produces a
warning naming the offender and leaves everything else working.

## Security

An AIR plugin's hooks execute arbitrary commands with your permissions, and its skills
can instruct the model to do anything. Read a catalog before you point Pi at it, the
way you would read a shell script from someone else.

## License

[MIT](LICENSE)
