# CUELO Agent Guide

## Overview

[CUELO](https://github.com/gim47656-ship-it/CUELO) is an open-source browser workspace and multi-agent harness built around the [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi) SDK. Both the terminal `omp` CLI and CUELO share `~/.omp/agent` for sessions, credentials, and model settings.

- **When to use what**: Plain `omp` CLI suits terminal-only use; CUELO is for browser workspace and inspectable multi-agent work (Main/Maker delegation, review verdicts, sidecars, and usage cards).
- **Package boundary**: `omp-web` is a separate upstream package and is not required to install or run CUELO.

## Prerequisites & Platform Support

| Requirement | Details |
| --- | --- |
| **Node.js** | `>=22.19.0` (with npm) |
| **Bun** | `>=1.4.2` (required to run the server and sidecars) |
| **Git** | Required for source checkouts and Git operations (worktrees, commits); optional for npm install and basic chat |

**Verification status**:
- **Developed & verified on**: Windows and Linux (WSL2 Ubuntu 24.04).
- **CI coverage**: [Public CI](https://github.com/gim47656-ship-it/CUELO/actions) runs full checks on Linux and install/build smoke checks on Windows. These checks do not prove compatibility across all Linux distributions or verify end-to-end provider login on a clean OS.
- **macOS**: Unverified; operation and support are not guaranteed.

## Quick Start (npm)

```bash
npm install -g cuelo
cuelo setup
cuelo start
```

In a separate terminal, verify that the web app and three local sidecars (`usage`, `btw`, `subagent`) respond:

```bash
cuelo health
```

By default, CUELO listens on `http://127.0.0.1:30141` (sidecars on `30142`–`30144`). If ports are in use, pass `--port-base <port>` to both `cuelo start` and `cuelo health`.

## Profile & Operational Boundaries

- **Existing profile preserved**: `cuelo setup` adds only missing public harness files to `~/.omp/agent` and creates `config.yml` only if none exists. It never overwrites existing `config.yml`, `models.yml`, `agent.db`, skills, sessions, or user-modified harness files.
- **User responsibilities**: The user must handle provider authentication (OAuth or API keys), model role selection, billing/quota checks, and permission/trust decisions. Agents and installers must not fabricate credentials or bypass approval prompts.
- **Health check scope**: `cuelo health` checks only local HTTP responses across the four services. It does **not** verify provider authentication, model availability, Jev judgment routing, or live chat success.

## Reference Links

- **Repository**: https://github.com/gim47656-ship-it/CUELO
- **Installation & Profile Guide**: https://github.com/gim47656-ship-it/CUELO/blob/main/docs/installation.md
- **Harness Guide**: https://github.com/gim47656-ship-it/CUELO/blob/main/docs/harness.md
- **Releases**: https://github.com/gim47656-ship-it/CUELO/releases
- **CI Actions**: https://github.com/gim47656-ship-it/CUELO/actions
- **omp (oh-my-pi) Upstream Engine**: https://github.com/can1357/oh-my-pi
