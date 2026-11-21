# Troubleshooting

Start with `hookmux doctor`, then use `explain` and the log to see why a plugin did or did not fire.

- Run `hookmux doctor` first. It reports problems with the install, the agent configs and your plugins. `hookmux doctor --fix` repairs what is safe to repair.
- To see why a plugin did or did not fire, run `hookmux explain "<the prompt>"`.
- To trace real hook runs, turn the log on, reproduce the problem, then read `~/.hookmux/logs/hookmux.log`:

  ```sh
  hookmux log on
  # ...use your agent...
  hookmux log off
  ```

- To switch hookmux off for one session without uninstalling it, start the agent with `HOOKMUX_DISABLE=1` in its environment. Guard plugins keep running, because a session can set that variable itself; turn one off with `hookmux disable <id>`, which the next session start reports.
