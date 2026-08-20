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

> **Status: scaffold.** This repository currently holds only `README.md`, `LICENSE`,
> `.gitignore`, and `AGENTS.md` (with a `CLAUDE.md` symlink). The packages, the CI workflows,
> and the test suite described below are the *plan*, not the current contents. Implementation
> is in progress.

## What this will publish

Pi packages, installable with `pi install npm:<package>`:

| Package | What it does |
|---|---|
| **hooks** | A Pi extension implementing a declarative hook runner: a config file maps Pi lifecycle events (`session_start`, `tool_call`, `tool_result`, …) to commands or handlers, with the ability to block or rewrite a tool call. The layer Pi's extension API makes possible but does not provide. |
| **a starter bundle** | A handful of genuinely useful extensions, skills, and prompts shipped as a pi package — the practical demonstration that the hook layer works, and the thing the e2e suite exercises. |

Exact package names, boundaries, and public API are decisions for the implementation work —
see `AGENTS.md`.

## Testing philosophy

The test suite that matters here is **end-to-end against real Pi**. E2E tests download a
**pinned** version of the Pi coding agent CLI and drive it for real, with the model provider
pointed at a **simulated LLM API on localhost** that returns well-formed placeholder
responses. No vendor API key, no network egress to a model provider, and no mocking of Pi
itself — the thing under test is whether a hook actually fires inside a real Pi run.
`AGENTS.md` carries the reasoning and the constraints.

## Known prerequisite: `NPM_TOKEN`

Publishing to npm requires an `NPM_TOKEN` repository secret, which is not configured on this
repository. Until a human creates an npm automation token and adds it, the release half of CI
cannot publish; build and test CI does not depend on it. Agents should not attempt to create
or obtain that credential.

## License

[MIT](LICENSE)
