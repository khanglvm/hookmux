# Security policy

## Supported versions

Security fixes go into the latest release only.

## Reporting a vulnerability

Report it privately through GitHub: open the repository's Security tab and choose "Report a vulnerability", or go to <https://github.com/khanglvm/hookmux/security/advisories/new>. Please do not open a public issue, pull request or discussion for it.

Include the hookmux version (`hookmux --version`), the agent client and its version, your operating system, and the steps or plugin that reproduce the problem. A minimal `plugin.toml` and the prompt or tool call that triggers it help most.

## What counts

hookmux runs inside the agent clients it is registered with, on every event it has an entry for, so these are in scope:

- A plugin that runs, or runs changed content, without `hookmux promote` (outside the `auto_trust_declarative` setting you turned on).
- A way for an agent or a non-interactive process to turn a plugin on without the person's answer: a terminal `y`, the client's permission prompt, or a card's code sent in the person's own prompt.
- Prompt text written to the decision log while `--prompts` is off.
- Model output reaching the agent's context through a template.
- A hook run that blocks, crashes or hangs an agent client instead of failing open.
- A host payload or plugin file that makes hookmux read or write outside `~/.hookmux` and the client configs it manages.

Out of scope: anything that already needs shell access as your user, such as editing `~/.hookmux` or a client's config directly. The trust pins catch changes nobody approved, and they do not sandbox plugins from someone who can edit those files.

`promote` refuses `--yes`. Without a terminal, or with the environment variables Claude Code, Codex and Gemini CLI set on the commands they run, it activates nothing: it prints a card and a code, and the plugin turns on only after hookmux's own prompt hook sees the person send that code (or the client's permission prompt is answered). A terminal is not proof that a person is typing, so this is a checkpoint against injected or accidental activation, not a defence against a malicious process running as your user: such a process can open a pseudo-terminal, clear its environment, edit `trust.json`, or send the hub's launcher a made-up prompt payload (or start a second agent client) carrying a card's code. Any other way through it from a normal agent tool call, or from a plugin's own content, is in scope.
