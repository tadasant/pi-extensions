# pi-extensions

**Hooks and plugins for the [Pi coding agent](https://github.com/earendil-works/pi)**, published
to npm so any Pi installation — or any orchestrator that drives Pi — can install them with
`pi install npm:<package>`.

Pi ships a first-class [extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md):
a TypeScript module gets an `ExtensionAPI` handle and can subscribe to lifecycle events,
register tools, and register commands. What Pi does **not** ship is the layer above that —
the declarative, config-driven **hooks** and the packaged, distributable **plugins** that
agents like Claude Code expose. This repository builds that layer on top of Pi's extension
API and publishes it as npm packages.

The sibling concern, MCP, is handled elsewhere: [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter)
(and Tadas's fork, [`tadasant/pi-mcp-adapter`](https://github.com/tadasant/pi-mcp-adapter))
already gives Pi MCP support as a Pi extension. Nothing in this repo re-implements MCP.

> **Status: scaffold.** This repository currently holds only the license, this README, and
> the agent-facing `AGENTS.md`. The packages, the CI workflows, and the test suite described
> below are the *plan*, not the current contents. Implementation is in progress.

## What this will publish

Two npm packages, both installable into Pi as extensions:

| Package | What it does |
|---|---|
| **hooks** | A declarative hook runner: a JSON/TS config maps Pi lifecycle events (`session_start`, `tool_call`, `tool_result`, …) to commands or handlers, with the ability to block or rewrite a tool call. The Pi analogue of a Claude Code hook. |
| **plugins** | A plugin format and loader: a bundle of hooks, commands, and prompts distributed as one installable unit, so a capability can be shipped and versioned as a package rather than pasted into a config. |

Exact package names, boundaries, and public API are decisions for the implementation work —
see `AGENTS.md`.

## Testing philosophy

The test suite that matters here is **end-to-end against real Pi**. E2E tests download a
**pinned** version of the Pi coding agent CLI and drive it for real, with the model provider
pointed at a **simulated LLM API on localhost** that returns well-formed placeholder
responses. No vendor API key, no network egress to a model provider, and no mocking of Pi
itself — the thing under test is whether a hook or plugin actually fires inside a real Pi
run. `AGENTS.md` carries the reasoning and the constraints.

## Known prerequisite: `NPM_TOKEN`

Publishing to npm needs an `NPM_TOKEN` repository secret, and **no `tadasant/*` repository
has one today** — `tadasant/zimmer`, `tadasant/strad`, and `tadasant/pi-mcp-adapter` were all
checked and none carries one. Until a human creates an npm automation token and adds it as a
repo secret here, the release half of CI cannot publish. Build and test CI does not depend on
it. Agents should not attempt to create or obtain that credential.

## License

[MIT](LICENSE)
