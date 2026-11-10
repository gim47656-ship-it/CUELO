# cuelo-plugins

Plugin Lab plugins, one folder per plugin id (`<id>/plugin.json` plus its files). The profile sync installs
this folder as `~/.omp/agent/cuelo-plugins/`, which is what sessions load.
Plugins are written straight into this folder as part of a normal reviewed change and deploy in the same turn;
there is no separate experiment or promotion stage. The format is in `skills/plugin-lab/SKILL.md`.
