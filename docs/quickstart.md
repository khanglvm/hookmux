# Write your first plugin

This walkthrough builds a plugin that stops any prompt that looks like it contains an AWS key or a GitHub token, then checks it without opening an agent. It assumes you have already run `hookmux init`; see [Install](install.md).

1. Create the plugin folder:

   ```sh
   hookmux new no-secrets
   ```

2. Replace `no-secrets/plugin.toml` with:

   ```toml
   schema = 1
   id = "no-secrets"
   events = ["prompt.submit"]
   phase = "guard"
   when = "secret_shape"

   [checks.secret_shape]
   kind = "regex"
   patterns = ['AKIA[0-9A-Z]{16}', 'ghp_[A-Za-z0-9]{36}']

   [[then]]
   effect = "block"
   reason = "The prompt looks like it contains a credential. Remove it and send again."
   ```

3. Install it and turn it on:

   ```sh
   hookmux add ./no-secrets
   hookmux promote no-secrets
   ```

   hookmux runs a plugin only after you approve it. `promote` shows what the plugin is allowed to do (block, add context, run scripts) and asks you to type `y`, so an agent cannot switch on code that runs on every prompt without you. Run it in your own terminal.

4. Check what it decides for a prompt, without opening an agent:

   ```sh
   hookmux explain "deploy with AKIAIOSFODNN7EXAMPLE"
   ```

Every agent you set up with `init` now refuses that prompt and shows the reason.

If you run hookmux from a source checkout, replace `hookmux` in these commands with `node /path/to/hookmux/dist/cli.mjs`, as described in [Install](install.md).

You can also ask your agent to write a plugin for you, for example "make a hook that reminds me to run the tests before a release". hookmux installs an authoring skill into each agent that walks it through writing, testing and installing the plugin. The agent installs the plugin in shadow mode, where it runs and is logged but adds nothing, and you approve it when you are ready.

To see what each part of the manifest means, read [How plugins decide](how-plugins-decide.md). To add test cases, read [Test a plugin](testing.md).
