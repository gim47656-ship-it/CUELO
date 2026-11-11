# cuelo-plugins

Plugin Lab plugins, one folder per plugin id (`<id>/plugin.json` plus its files). The profile sync installs
this folder as `~/.omp/agent/cuelo-plugins/`, which is what sessions load.
Plugins are written straight into this folder as part of a normal reviewed change and deploy in the same turn;
there is no separate experiment or promotion stage. The format is in `skills/plugin-lab/SKILL.md`.

Record improvements to the same capability in the optional `enhancements` array, oldest first.
Each entry has an ISO date-time with a timezone in `at` and one user-facing Korean sentence in
`summary`. Independent new capabilities get a new plugin ID; user-toggleable capabilities ship
as plugins rather than always-on extensions. See the skill above for validation and display rules.
