# pi-extensions

**Hooks and [AIR](https://github.com/pulsemcp/air) plugin support for the
[Pi coding agent](https://github.com/earendil-works/pi)**, published to npm as
[pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
so any Pi installation — or any orchestrator that drives Pi — can install them with
`pi install npm:<package>`.

## The two gaps this fills

Pi ships a first-class [extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
and a [package format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).
Distribution is a solved problem, and this repository uses it rather than reinventing
it — that package format is *how these packages reach you*. What Pi lacks is two
things it can consume once someone builds them.

**1. Declarative hooks.** Pi's extension API lets you subscribe to `tool_call` and
return `{ block: true }` — that is the primitive. There is no way to express a policy
as configuration rather than as a TypeScript module you write, install, and maintain,
and the word `hooks` appears nowhere in Pi's docs.

**2. AIR plugins.** [AIR](https://github.com/pulsemcp/air) is a vendor-neutral
framework for AI artifacts, with six artifact types — skills, references, MCP servers,
plugins, roots, hooks. An AIR **plugin** is the compositional one: a manifest that
bundles other artifacts *by ID* rather than a directory of content. It is a different
artifact type from a different ecosystem, and Pi cannot read it at all. Making Pi able
to is this repository's second reason to exist — the same role
`@pulsemcp/air-adapter-opencode` plays for OpenCode.

The sibling concern, MCP, is handled elsewhere: [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter)
(and Tadas's fork, [`tadasant/pi-mcp-adapter`](https://github.com/tadasant/pi-mcp-adapter))
already gives Pi MCP support as a Pi extension. Nothing in this repo re-implements MCP.

> **Status: implemented, not yet published.** Both packages, the test suite, and CI all
> exist and are green. Publishing to npm is blocked on an `NPM_TOKEN` repository secret
> that does not exist yet — see [Known prerequisite](#known-prerequisite-npm_token).

## What this publishes

Exactly two pi packages, installable with `pi install npm:<package>`:

| Package | What it does |
|---|---|
| [**`@tadasant/pi-hooks`**](packages/pi-hooks) | The Pi runtime for **AIR hooks**: `hooks.json` index + `HOOK.json` directories, run against Pi's lifecycle, where a non-zero exit blocks the event. Ships a small AIR catalog of guardrails, and a Pi-native superset config for what AIR's schema cannot express (a written block reason, rewriting tool input). |
| [**`@tadasant/pi-plugins`**](packages/pi-plugins) | The Pi adapter for **AIR plugins**. Resolves an AIR plugin — including composition, `.plugin/plugin.json` manifests, and `default_in_roots` membership — and activates everything it bundles: skills through Pi's own skill loading, hooks through the bundled hooks engine, and MCP servers through [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter), a required peer. |

Each package's README carries its full configuration reference.

## AIR hooks in one example

An AIR hook is an index entry plus a `HOOK.json`:

```json
// hooks.json
{ "block-prod-deploy": { "description": "Refuse production deploys", "path": "hooks/block-prod-deploy" } }
```
```json
// hooks/block-prod-deploy/HOOK.json
{ "event": "pre_tool_call", "matcher": "deploy.*production", "command": "./guard.sh" }
```

Point Pi at the catalog with an `air.json` and the hook is live: a non-zero exit
blocks the tool call, with stderr as the reason the model is given. No TypeScript, no
extension to maintain, and the artifact is portable to any AIR-aware agent.

## AIR plugins in one example

Point Pi at an AIR config and the adapter resolves what a plugin bundles:

```json
// plugins.json — a thin registry
{
  "code-quality": {
    "description": "Repository conventions plus a guardrail against production deploys",
    "path": "./plugins/code-quality",
    "default_in_roots": ["*"]
  }
}
```

```json
// plugins/code-quality/.plugin/plugin.json — the body, referencing artifacts by ID
{
  "title": "Code Quality Suite",
  "version": "1.2.0",
  "skills": ["repo-conventions"],
  "mcp_servers": ["eslint-server"],
  "hooks": ["block-prod-deploy"]
}
```

Pi then loads `repo-conventions` as a skill, enforces `block-prod-deploy` as a hook,
and runs `eslint-server` through `pi-mcp-adapter`. Supporting plugins means supporting
what a plugin bundles — so `@tadasant/pi-plugins` composes with the extensions that
already provide those capabilities rather than reimplementing them: the hooks engine
is bundled, and `pi-mcp-adapter` is a required peer you install alongside it.

```bash
pi install npm:pi-mcp-adapter      # required peer
pi install npm:@tadasant/pi-plugins
```

## Testing philosophy

The test suite that matters here is **end-to-end against real Pi**. E2E tests download a
**pinned** version of the Pi coding agent CLI (`e2e/pi-version.json`, currently `0.84.2`) and
drive that binary for real, with the model provider pointed at a **simulated LLM API on
localhost** that returns well-formed placeholder responses. No vendor API key, no network
egress to a model provider, and no mocking of Pi itself — the thing under test is whether a
hook actually fires inside a real Pi run.

The simulated API speaks the OpenAI Chat Completions streaming wire protocol and reaches Pi
through Pi's own documented custom-provider seam (`models.json`). It replays a scripted list
of turns, so a test can make the "model" call a tool and thereby reach hook paths that only
trigger on tool use. Assertions run against Pi's own `--mode json` event stream, and — where
it matters — against the filesystem, to prove a blocked call had no side effect.

```bash
npm test          # unit: AIR hooks + bundled catalog, matching/actions, plugin resolution
npm run test:e2e  # e2e: the real pinned Pi binary, driven end to end
```

`AGENTS.md` carries the reasoning and the constraints.

## Known prerequisite: `NPM_TOKEN`

Publishing to npm requires an `NPM_TOKEN` repository secret, which is **not configured on this
repository**. Until a human creates an npm automation token with publish rights on the
`@tadasant` scope and adds it, `.github/workflows/release.yml` cannot publish — it fails fast
with that message rather than half-publishing.

Everything up to that line is verified without the credential: `npm run pack:dry-run` runs
`npm publish --dry-run` for both packages and then asserts the resulting tarballs actually
contain the resources their `pi` manifests promise. That job runs on every pull request.
Build and test CI does not depend on the secret in any way. Agents should not attempt to
create or obtain that credential.

Once the token exists, tagging `v0.1.0` publishes both packages with npm provenance.

## License

[MIT](LICENSE)
