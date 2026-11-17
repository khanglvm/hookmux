# Security policy

## Supported versions

Security fixes go into the latest release only.

## Reporting a vulnerability

Report it privately through GitHub: open the repository's Security tab and choose "Report a vulnerability", or go to <https://github.com/khanglvm/hookmux/security/advisories/new>. Please do not open a public issue, pull request or discussion for it.

Include the hookmux version (`hookmux --version`), the agent client and its version, your operating system, and the steps or plugin that reproduce the problem. A minimal `plugin.toml` and the prompt or tool call that triggers it help most.

## What counts

hookmux runs inside the agent clients it is registered with, on every event it has an entry for, so these are in scope:

- A plugin that runs, or runs changed content, without `hookmux promote` (outside the `auto_trust_declarative` setting you turned on).
- A way for an agent or a non-interactive process to promote a plugin.
- Prompt text written to the decision log while `--prompts` is off.
- Model output reaching the agent's context through a template.
- A hook run that blocks, crashes or hangs an agent client instead of failing open.
- A host payload or plugin file that makes hookmux read or write outside `~/.hookmux` and the client configs it manages.

Out of scope: anything that already needs shell access as your user, such as editing `~/.hookmux` or a client's config directly. The trust pins catch changes nobody approved, and they do not sandbox plugins from someone who can edit those files.
