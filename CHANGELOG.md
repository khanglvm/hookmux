# Changelog

## [0.2.0](https://github.com/khanglvm/hookmux/compare/v0.1.0...v0.2.0) (2026-11-21)


### Features

* add `hookmux install` for one-line plugin installs ([c8af364](https://github.com/khanglvm/hookmux/commit/c8af3643a335d8c11a3db34d1c8ab6bd62314579))
* add opencode support and per-host compatibility checks ([ef5eb3e](https://github.com/khanglvm/hookmux/commit/ef5eb3e4ef2ac27fc8eb5d62c751dd2823bb1abf))
* add plugin templates and a publishable repo scaffold to `hookmux new` ([c8af364](https://github.com/khanglvm/hookmux/commit/c8af3643a335d8c11a3db34d1c8ab6bd62314579))
* approve Codex hub entries and add standing approvals for promote ([22f43a2](https://github.com/khanglvm/hookmux/commit/22f43a2c610fd1cebcc5ed22b5f008bcc9502b40))
* let a person approve promote from Claude Code's permission prompt ([542497e](https://github.com/khanglvm/hookmux/commit/542497e972d18dfd69e44c8a9e8f476bc1f70a62))
* let a script check pass named environment variables and keep longer evidence ([fb8e254](https://github.com/khanglvm/hookmux/commit/fb8e2544b447e7e98405eb097a7f0b72877c060c))
* let agents install and approve plugins after showing the user a risk card ([c8af364](https://github.com/khanglvm/hookmux/commit/c8af3643a335d8c11a3db34d1c8ab6bd62314579))
* name guard plugins that are off at every session start ([4d34797](https://github.com/khanglvm/hookmux/commit/4d34797996b30cf149ff3b3ffc1273153d454007))
* shadow preview for unpromoted plugins and score scripts in when ([2861749](https://github.com/khanglvm/hookmux/commit/2861749597aaf589ac4102521047c8cf20552632))
* show how long each plugin takes in `hookmux test` and `hookmux doctor` ([c8af364](https://github.com/khanglvm/hookmux/commit/c8af3643a335d8c11a3db34d1c8ab6bd62314579))
* support Qwen Code, Factory Droid, Qoder CLI and CodeBuddy Code ([266846c](https://github.com/khanglvm/hookmux/commit/266846c13d627111f85222f938a238865d874fa7))


### Bug Fixes

* add hub entries for plugins that are waiting for promote ([af8dd2e](https://github.com/khanglvm/hookmux/commit/af8dd2e240b305c1270a861a8cde98e0dc7b5a8c))
* approve Codex hub entries under a symlinked home, and never wait on app-server ([1c6e663](https://github.com/khanglvm/hookmux/commit/1c6e663e2b3e80d5af0a1d7a6eec4d0fad3f476c))
* approve only a Codex hub entry in the shape hookmux writes ([be2e38f](https://github.com/khanglvm/hookmux/commit/be2e38f2eefe1921a2576ff7fa2adfe7b075db61))
* close activation and fail-open gaps found in review ([f13ad13](https://github.com/khanglvm/hookmux/commit/f13ad1315796f625fd2d8c57a4c49678145d93f9))
* close round-2 review gaps (test trust, script groups, cache, launcher temp) ([b5590a9](https://github.com/khanglvm/hookmux/commit/b5590a9e067576b188d31d0b7b30b5680b71f135))
* count a guard set only in a host table, and recompile old registries ([7892132](https://github.com/khanglvm/hookmux/commit/7892132176dbcf167f83f0ef7bb954384403d116))
* count an older-form Codex hub entry once it is approved in /hooks ([657a6a5](https://github.com/khanglvm/hookmux/commit/657a6a5558a8f589fd4e217e226976e942b21dde))
* doctor survives a launcher that exits before reading stdin ([10743dc](https://github.com/khanglvm/hookmux/commit/10743dc431d011086cd664104679fac07923b255))
* find a pending plugin's events in its capabilities ([050e56a](https://github.com/khanglvm/hookmux/commit/050e56a59f5e33b6981268ce96a94f43c8de9642))
* keep guards running when a session asks hookmux to stand down ([e49066a](https://github.com/khanglvm/hookmux/commit/e49066aca645852d2389c764224c89579e918d99))
* keep guards under HOOKMUX_DISABLE when a host table changes phase ([d0fcc33](https://github.com/khanglvm/hookmux/commit/d0fcc33836eac6789da31bfe78322115e8a5c569))
* keep PATH and folder names from shaping the launcher and notice ([9f84b7d](https://github.com/khanglvm/hookmux/commit/9f84b7dc7fc60ab312c2cdc7363aea68dac11657))
* match Codex hub entries under the default ~/.codex symlink ([6a4c5ff](https://github.com/khanglvm/hookmux/commit/6a4c5ff7d0c08dae4a3ba60ed7af29b3ecb23a50))
* re-verify cached script copies and document the 5 s launcher limit ([15f9a07](https://github.com/khanglvm/hookmux/commit/15f9a076954c7bd5dd5b22ba2f17178d5a9d0694))
* record a Node path that survives a Node upgrade ([a15a261](https://github.com/khanglvm/hookmux/commit/a15a26159792e80a3ac80906227d28178f7463c4))
* require promotion for longer script evidence ([37ae376](https://github.com/khanglvm/hookmux/commit/37ae376a4bb0cb07b3543349e22ef024d48aaed4))
