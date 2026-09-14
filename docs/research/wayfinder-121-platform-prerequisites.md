# Wayfinder #107 / #121: platform prerequisites and OS-neutrality evidence

Status: read-only platform research for [issue #121](https://github.com/xiakeng/sandcastle-runner/issues/121); no implementation or end-to-end run was performed.

Checked: 2026-09-14.

## Bottom line

The Runner can present the same user-facing workflow on native Linux, macOS, and Windows when its external prerequisites are installed and on `PATH`: Node.js (minimum `22.18.0`), npm, Git, GitHub CLI (`gh`), and an authenticated Codex CLI. Node's v22.18.0 release includes official binaries for all three OS families, and Node 22.18.0 enables built-in TypeScript type stripping, which is relevant because this package executes `.ts` entrypoints directly. These vendor support statements do not prove the Runner's complete workflow on every OS.

One internal Linux-only assumption remains visible in the current source: [`src/recovery-lock.ts`](../../src/recovery-lock.ts#L27) starts the external `flock` command. `flock` is not a Node, npm, Git, GitHub CLI, or Codex prerequisite documented for Windows or macOS. The lock path therefore cannot be called OS-neutral until it is replaced or given an explicitly tested platform implementation.

Codex's official CLI pages document installation and sign-in flows but do **not** state a minimum Node.js version, a complete OS-version matrix, or a guarantee that every Runner/Sandcastle mode works on each host. Treat Codex availability as an operator prerequisite that must be checked locally, not as a version claim supplied by this project.

## First-party facts

### Node.js and npm

- The Node.js v22.18.0 archive is an LTS release and lists Windows x64/x86/ARM64 installers, macOS x64/ARM64 packages, and Linux x64/ARMv7/ARM64/ppc64le/s390x binaries (plus AIX). The archive reports npm `10.9.3` bundled with that release. [Node.js v22.18.0 archive](https://nodejs.org/en/download/archive/v22.18.0)
- Node.js v22.18.0 enabled TypeScript type stripping by default. It only handles erasable TypeScript syntax, performs no type checking, ignores `tsconfig.json` path aliases, and requires `type`-qualified type imports where applicable. [v22.18.0 release notes](https://nodejs.org/en/blog/release/v22.18.0), [Node v22.18.0 TypeScript documentation](https://nodejs.org/download/release/v22.18.0/docs/api/typescript.html)
- Node's v22.18.0 platform table is conditional on OS, architecture, and libc. Tier 1 includes GNU/Linux x64/arm64/armv7 (kernel >= 4.18, glibc >= 2.28), Windows x64/x86 on Windows 10/Server 2016 or newer and Windows ARM64 on Windows 10 or newer, and macOS x64/arm64 on macOS 11 or newer. Node says production applications should use supported tiers and does not support vendor end-of-life operating systems. [Node v22.18.0 supported platforms](https://github.com/nodejs/node/blob/v22.18.0/BUILDING.md#supported-platforms)
- npm's default local install puts dependencies in the current project’s `node_modules`; global installation is a separate `-g/--global` mode. A folder dependency outside the project is symlinked by default, while `--install-links` installs packed contents instead. [npm install](https://docs.npmjs.com/cli/v11/commands/npm-install), [npm folders](https://docs.npmjs.com/files/folders.html)
- `npm ci` is the appropriate clean-checkout command: it requires an existing `package-lock.json` or shrinkwrap, fails when the lock and manifest disagree, removes an existing `node_modules`, and does not write the manifest or lock. [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci)
- npm's local executables are linked under `./node_modules/.bin`, which is why the documented `npm exec -- sandcastle-runner ...` invocation is preferable to a hard-coded OS path. [npm folders — Executables](https://docs.npmjs.com/files/folders.html#executables)
- npm scripts use a platform-dependent shell by default (`/bin/sh` on POSIX and `cmd.exe` on Windows). Runner scripts should therefore continue using Node/npm binaries and avoid shell-only syntax. [npm scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts#description)

### Git

- Git's first-party installation pages provide native installation options for Windows, macOS, and Linux. The pages intentionally defer version selection to the host distribution or maintained installer; the Runner should require a working Git executable rather than pin a vendor-specific package version. [Git for Windows](https://git-scm.com/install/windows), [Git for macOS](https://git-scm.com/install/mac), [Git for Linux](https://git-scm.com/install/linux)
- `git worktree add`, `list --porcelain`, and `remove` are standard Git operations for linked working trees. Git documents that linked worktrees share repository data but have per-worktree `HEAD` and index; `remove` is restricted to clean worktrees unless `--force` is used. [git-worktree manual](https://git-scm.com/docs/git-worktree)
- Git documents `GIT_CONFIG_GLOBAL` as the environment variable that selects the global config file and prevents the normal user config files from being read. This is the portable mechanism used by Runner/Sandcastle to isolate per-attempt Git configuration; the file path itself must still be constructed with Node's path APIs. [Git environment variables](https://git-scm.com/docs/git#Documentation/git.txt-GITCONFIGGLOBAL)

### GitHub CLI (`gh`)

- The official `cli/cli` project states that GitHub CLI supports GitHub.com, GitHub Enterprise Cloud, supported GHES versions, and macOS, Windows, and Linux. Its installation section links maintained package-manager and prebuilt options for each OS. [GitHub CLI README](https://github.com/cli/cli#installation)
- `gh auth login` supports browser or token flows; the manual specifically calls environment-token authentication suitable for headless use. `GH_TOKEN` (then `GITHUB_TOKEN`) avoids an authentication prompt and takes precedence over stored credentials. [gh auth login](https://cli.github.com/manual/gh_auth_login), [gh environment](https://cli.github.com/manual/gh_help_environment)
- `GH_CONFIG_DIR` has OS-dependent defaults (`$XDG_CONFIG_HOME/gh`, `%AppData%/GitHub CLI`, or `$HOME/.config/gh`). Code and documentation should not assume a Unix config path. [gh environment](https://cli.github.com/manual/gh_help_environment)

### Codex CLI

- OpenAI's Codex CLI quickstart says to install the CLI, sign in, and run `codex` from a project directory. It documents standalone installers for macOS/Linux and Windows, plus npm and Homebrew installation options. [Codex CLI quickstart](https://learn.chatgpt.com/docs/codex/cli)
- Codex CLI authentication supports signing in with ChatGPT or an API key; `codex login status` reports the active method. API-key authentication supports local CLI workflows, while some cloud/workspace features may be unavailable. [Codex authentication](https://learn.chatgpt.com/docs/auth)
- OpenAI's docs do not specify a minimum Node.js release or a complete native-OS version matrix for Codex CLI. This is an evidence gap: README text should require an installed, runnable, authenticated `codex` executable without inventing a Codex version floor.
- If the operator uses Codex's default sandboxing, platform prerequisites differ: macOS uses Seatbelt, native Windows uses the Windows sandbox in PowerShell, WSL2 uses the Linux implementation, and Linux/WSL2 may require `bubblewrap` plus user-namespace support. These are Codex sandbox requirements, not a Runner guarantee; the Runner's `noSandbox` execution mode changes which of them apply. [Codex sandboxing](https://learn.chatgpt.com/docs/sandboxing)

## Runner-facing prerequisite matrix

| Boundary | Linux (native) | macOS (native) | Windows (native PowerShell) | Evidence / acceptance check |
| --- | --- | --- | --- | --- |
| Node runtime | Node >=22.18.0; use a supported glibc/libc and non-EoL distro | Node >=22.18.0 on macOS >=11.0 | Node >=22.18.0 on Windows >=10/Server 2016 (ARM64 >=10) | `node --version`; `node -e "console.log(process.version)"`; run the `.ts` CLI entrypoint |
| npm checkout install | `npm ci` from repository root | same | same | Lockfile remains unchanged; `node_modules/.bin/sandcastle-runner` exists after install |
| Git/worktrees | Git executable on `PATH`; worktree operations available | same | same; use native Windows paths | `git --version`; add/list/remove a temporary linked worktree; verify clean removal |
| GitHub API and Git transport | `gh` on `PATH`; non-interactive `GH_TOKEN`/`GITHUB_TOKEN` | same | same | `gh --version`; `gh auth status` or a read-only `gh api` call without printing token; `git fetch/push` through the configured credential helper |
| Codex execution | `codex` on `PATH`, authenticated; default sandbox may need `bubblewrap` | `codex` on `PATH`, authenticated; Seatbelt is built in for default sandbox | `codex` on `PATH`, authenticated; PowerShell uses native Windows sandbox | `codex --version`; `codex login status`; any real agent run remains an opt-in integration check |
| Runner lock | **Currently blocked:** source invokes `flock` | **Currently blocked:** no documented `flock` prerequisite | **Currently blocked:** no documented `flock` prerequisite | Replace/port the lock and run contention/release tests on all native hosts |

## Cross-platform proof plan

1. Run the existing unit and check commands from a checkout on each native OS. Keep paths with spaces and use `path.join`/`path.resolve` in fixtures; do not encode `/tmp`, `/`, or backslash separators in expected values.
2. Add a native Git smoke check that creates a temporary repository, creates a branch/worktree, reads `git worktree list --porcelain`, and removes the clean worktree. Include a path containing spaces; this exercises the same commands used by [`LocalGitWorkspace`](../../src/adapters/git-workspace.ts#L20-L119).
3. Exercise the CLI through npm (`npm exec -- sandcastle-runner --help`) rather than invoking a generated `.bin` path directly. This catches Node's `.ts` loader, npm bin linking, and Windows command-shim behavior together.
4. Verify headless GitHub access with a non-mutating `gh` command under the configured token environment. Do not use interactive `gh auth login` in Runner automation; the token precedence documented above is the portable contract.
5. Treat a real Codex/Sandcastle execution as an external integration test. Record the host OS, Node version, Git/gh/Codex versions, authentication mode, and sandbox mode; a passing Linux run is not evidence for macOS or Windows.
6. The current CI workflow runs only `ubuntu-latest` (and Node 24), so it cannot prove this matrix. Native macOS and Windows jobs are needed before claiming OS-neutral support; WSL2 should be reported separately from native Windows and native Linux.

## Evidence gaps and non-claims

- Node's support table describes Node itself, not this Runner's use of Sandcastle, GitHub APIs, or Codex. Node 22.x patch releases can change platform tiers; retain the v22.18.0 source link for the stated floor and re-check when changing the floor.
- Git and GitHub CLI installation pages do not define a single minimum Git/`gh` version for this project. Do not add one without a tested feature requirement.
- OpenAI's Codex pages do not promise a minimum OS/Node version for the CLI or parity for the Runner's no-sandbox mode. Availability depends on installation, account/workspace policy, network, and authentication.
- No official source was found that makes `flock` portable. Its current use is a repository implementation constraint, not a user prerequisite to copy into README.
