# Product

## Platform

cli

## Stack

TypeScript on Node 22 or later, bundled with esbuild and published to npm as `hookmux`. A POSIX shell launcher runs the hook engine.

## Users

Developers who run one or more coding agents (Claude Code, Codex, Gemini CLI, Qwen Code, Factory Droid, Qoder CLI, CodeBuddy Code) and want the same hooks in all of them. Also hook authors who want to write a hook once instead of once per client.

## Product Purpose

Each agent client has its own hook config, event names and output format. hookmux installs one entry per event in each client and runs plugins written against a single format, so adding or changing a hook means changing one plugin folder. Success is a plugin that behaves the same in every supported client, with no client config edits after `hookmux init`.

## Positioning

The usual alternative is a hand-written script per client. hookmux adds a declarative manifest, cheap rule checks before costly model calls, per-client effect fallbacks, and a trust step that keeps an agent from turning on its own hooks.

## Operating Context

Runs on the developer's machine (macOS or Linux) on every prompt and tool call, so it must answer within the client's hook timeout and never break the client. English docs.

## Capabilities and Constraints

- Canonical events: `prompt.submit`, `session.start`, `tool.before`, `tool.after`.
- Effects: inject context, block, notify the user. Clients that cannot perform an effect get a fallback or nothing.
- Checks: rules, scripts and optional model calls to an OpenAI-compatible endpoint the user configures.
- No telemetry; the decision log is off by default.

## Product Principles

- Never break the agent client: fail open.
- A person decides what runs: promote needs a human.
- Rules decide blocks; a model alone never does.
- Plugin authors never see client formats.

## Accessibility & Inclusion

Unknown: no stated targets for CLI output beyond plain text.
