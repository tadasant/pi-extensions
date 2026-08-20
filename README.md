# pi-extensions

**Hooks for the [Pi coding agent](https://github.com/earendil-works/pi), plus a set of ready-made
extensions**, published to npm as [pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
so any Pi installation — or any orchestrator that drives Pi — can install them with
`pi install npm:<package>`.

## What Pi already has, and what it doesn't

Pi ships a first-class [extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md):
a TypeScript module gets an `ExtensionAPI` handle and can subscribe to lifecycle events,
register tools, and register commands. It also ships a **package format** — extensions,
skills, prompt templates, and themes bundled and distributed over npm or git, version-pinned,
installable per-user or per-project. Distribution is a solved problem here, and this repo uses
it rather than reinventing it.

What Pi does **not** ship is a **declarative hook layer**: a way to say "run this command when
a tool call matches that pattern" in config, without writing a TypeScript extension. Claude
Code has one; Pi has no equivalent and no `hooks` concept anywhere in its docs. That gap is
this repository's reason to exist.

The sibling concern, MCP, is handled elsewhere: [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter)
(and Tadas's fork, [`tadasant/pi-mcp-adapter`](https://github.com/tadasant/pi-mcp-adapter))
already gives Pi MCP support as a Pi extension. Nothing in this repo re-implements MCP.

> **Status: implemented, not yet published.** The packages, the test suite, and CI all exist
> and are green. Publishing to npm is blocked on an `NPM_TOKEN` repository secret that does
> not exist yet — see [Known prerequisite](#known-prerequisite-npm_token).

## What this publishes

Pi packages, installable with `pi install npm:<package>`:

| Package | What it does |
|---|---|
| [**`@tadasant/pi-hooks`**](packages/pi-hooks) | A Pi extension implementing a declarative hook runner: `hooks.json` maps Pi lifecycle events (`session_start`, `tool_call`, `tool_result`, …) to actions, with the ability to block a tool call, rewrite its input, rewrite its result, or inject context. The layer Pi's extension API makes possible but does not provide. Ships five curated presets. |
| [**`@tadasant/pi-starter`**](packages/pi-starter) | A starter bundle: the hooks engine (bundled), a recommended blocking policy, two skills, and two prompt templates. One install gets a working, opinionated setup. |

Each package's README carries its full configuration reference.

## The hook layer in one example

`.pi/hooks.json`:

```json
{
  "extends": ["preset:secrets", "preset:git-guard"],
  "hooks": [
    {
      "name": "no-migrations-without-review",
      "on": "tool_call",
      "match": { "tool": ["write", "edit"], "input": { "path": "db/migrate/**" } },
      "action": { "type": "block", "reason": "Migrations are written by a human." }
    }
  ]
}
```

No TypeScript, no extension to maintain. That is the whole point: Pi's `tool_call`
subscription is the primitive, and this is the layer above it.

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
npm test          # 69 unit tests: matching, templating, config, action semantics
npm run test:e2e  # 42 e2e tests against the real pinned Pi binary
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
