---
description: Before Linux VM, browser, network, CUELO runtime update/troubleshooting or mounted-disk work.
---

# Runtime: native Linux CUELO

Install this file only as `~/.omp/agent/APPEND_SYSTEM.md` for native Linux (home and office Linux Mint), not WSL. `wsl/update.sh` and `linux/setup.sh` select it by runtime; WSL uses `wsl/APPEND_SYSTEM.md`. Installation/migration status: `Tools/CUELO_Setup/HANDOFF.md`, `Tools/CUELO_Setup/LINUX-SETUP.md`.

## Work on this Linux host
- CUELO and all tools run here. Use `/bin/bash` and Linux Git, Bun, Node, search, build and test binaries. No Windows interop: do not invoke `wsl.exe`, `powershell.exe`, `cmd.exe`, `*.exe` or `wslpath` here. `git_finalize` uses Linux `pwsh`.
- An old Windows `hostname` does not make this Windows; check `process.platform`, executables and working paths.
- Development: `~/src/CUELO-private`; runtime: `~/cuelo-run`. Run bulk Linux file work under home (ext4). Do not clone/move other projects without a user request.
- Access NTFS only through mounts (home PC: `/mnt/d`, `/mnt/e`); access grants no move/edit permission. Do not assume ext4 speed. Before repeated bulk scans, propose a home copy (`~/src/<이름>`, clone for Git) and create it only after approval. Never edit copy and original concurrently.
- If Windows hibernation/Fast Startup leaves NTFS read-only, do not force writes. Explain that options such as `remove_hiberfile` can destroy hibernation state and data; wait for a normal Windows shutdown.
- `OMP_EXE` points to the runtime's Linux CLI. Do not also run the migrated-from WSL CUELO or Windows `omp.exe` with the same credentials: either can refresh OAuth and invalidate the other's tokens.
- Python document/image modules (PyMuPDF, openpyxl, Pillow, ezdxf, python-docx, python-pptx) live in `~/.omp/python-env/bin/python`, not system `python3`. Eval selects it; bash must use that path. Install modules with `~/.omp/python-env/bin/python -m pip install`.
- `sqlite3` CLI may be absent. Read `~/.omp/agent/*.db`, `stats.db` and mnemopi DBs with bash `bun -e 'import {Database} from "bun:sqlite"; …'` (`{ readonly: true }` for reads) or eval Python `sqlite3`. Never change live DBs; use `/tmp` copies for large queries.

## Windows tools and browser
- This host lacks `windows_build`, `windows_control`, Windows `computer` helpers, ego lite and Windows OMP Browser Relay components. Report blockers and the required environment; do not hide failures or imitate missing tools. Except for the WinBoat VM below, do not install/start Wine, VMs or remote Windows substitutes without approval.
- Build/run Windows-only projects (MSBuild, VB6, COM, equipment tools) in Mint's WinBoat Windows VM, not on the host (user, 2026-11-08: 「사무실도 리눅스니까 윈도우 빌드 작업할 때는 VM으로」). Connect via `ssh winboat` in `~/.ssh/config`; its default shell is PowerShell 5.1. Join commands with `;`, not `&`; precede Korean output with `[Console]::OutputEncoding=[Text.Encoding]::UTF8`. Linux owns source; the VM only receives copies (user, 2026-11-09: 「정본은 리눅스가맡고 부산물들이나 산출물들이있는곳은 vm 쪽이지 사본」). For repositories mapped in `~/.omp/agent/vm-build.json`, `vm_build` sends Linux commits (or uncommitted work with `mode: "snapshot"`) one way to the VM, then runs MSBuild or `dotnet build|test` there. If unloaded, use `bun --no-install ~/.omp/agent/tools/vm-build/index.ts --repo <Linux 저장소> [--project <상대 경로>]`. If the VM copy is dirty or has commits Linux lacks, report its state; never overwrite it. Leave mapped bin/obj outputs in the VM. For unmapped repositories, copy to an English path, send via `tar`/`scp` to a VM work folder, build, then remove only those trial copies/outputs after checking. Send long VM commands through bash, not eval. Starting the installed VM container is authorized; ask before Windows updates, reboots or new software that alter the VM or interrupt open remote windows. Procedures/build combinations: `doc/history/2026/11/08-office-repos-vm-build/main.md`, `doc/history/2026/11/09-vm-build/main.md`. Preserve legacy encoding per `rule://legacy-encoding`.
- Browser routing and user-window protection follow `rule://surface-verification-procedure` (user correction, 2026-11-08).
  Linux ego uses the SDK at `~/Applications/ego-lite-linux-source` and CDP `127.0.0.1:32899`. Use default `profile: "user"`;
  the verify profile is unavailable, so logged-out-only checks remain unverified. Raw CDP in TaskSpaces uses global `cdp()`, not `page.cdp`.
  User-named existing tabs use `app: "http://127.0.0.1:32899"` and top-level `target`; new CDP pages need `newWindow: true` to avoid PWA tabs.
  Relay exists only on PCs with its extension. Without it set `browser.relay: false` and omit `browser.cdpUrl`.
  Linux Electron ego has no `Page.printToPDF` (2026-11-11: `'Page.printToPDF' wasn't found`), and draft PDF is WSL-only.
  For HTML/page-to-PDF output and PDF checks, use system `/usr/bin/chromium --headless --print-to-pdf` with a throwaway `--user-data-dir` under `/tmp` and local `file://` input (user decision, 2026-11-19: 「왜막혔냐 걍해도됨」). It never opens a visible window or the user's profile. Other browser work stays in ego TaskSpaces. Read `ego-browser-verify-recipes` and close only your TaskSpace with `finish: true`.
- `computer` uses Linux AT-SPI and X11 input. Mint Cinnamon's X11 session is assumed; Wayland limits per-window input and `raise()`. Ask before changing session type or accessibility settings.

## Network and Tailscale
- Network changes require explicit user approval, including Tailscale exit nodes, advertised or accepted routes, default routes, adapters and firewalls.
  Use ordinary tailnet connections; never make another PC the default router as a diagnostic.
- Linux `tailscale serve` forwards `https://<pc>.<tailnet>.ts.net` to `127.0.0.1:30141`. Changing/removing serve settings also needs approval. Inspect with `tailscale serve status`; the launcher reads allowed server names from `tailscale status --json`.

## Runtime, updates and data
- Server: systemd user unit `cuelo-30141`; login unit `cuelo-launch-30141.service` starts `linux/launch.sh start --no-open`. Status: `bash ~/cuelo-run/Tools/CUELO_Setup/linux/launch.sh status` (match exit 0, mismatch exit 3). Launcher log: `~/.omp/linux-cuelo-30141.launch.log`; server log: `journalctl --user -u cuelo-30141`; health: `cd ~/cuelo-run && node install.mjs health`.
- Update commands and completion criteria are canonical in `rule://deploy-ops`. Linux uses the shared updater, which skips Windows steps and relaunches with `linux/launch.sh`.
  The general Linux-to-Windows source-copy contract is also there; the WinBoat build-copy procedure above remains separate.
- Never overwrite live `~/cuelo-run/.next` with a dev server or production build. Prepare separate verification/update outputs, then use the supported cutover.
- Before restarting, preserve running work and the current session; warn the user of the brief interruption. Profile edits do not prove live settings changed: check actual roles, tools and session replies after restart.
- Pre-migration WSL distributions, Windows profiles, sessions and backups are rollback data. Migration completion does not authorize deleting them, stages or rollbacks.
