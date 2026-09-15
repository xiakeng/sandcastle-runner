# OS-specific code audit

Status: read-only audit; source files were not modified.

Checked: 2026-09-15.

Scope: TypeScript production code, package scripts, tests that exercise process and filesystem boundaries, and the existing prerequisite documentation. The repository has no `process.platform`/`process.arch` branches. Most filesystem paths use `node:path` (`join`, `resolve`, and `path.sep`), and Git's machine-readable paths are deliberately parsed with `path.posix`, so those areas do not show an OS binding.

## Findings

### High — Codex command shims cannot be launched on native Windows

- **Location:** [`src/adapters/no-shell-sandbox.ts`](../../src/adapters/no-shell-sandbox.ts#L60-L66) and [`src/adapters/no-shell-sandbox.ts`](../../src/adapters/no-shell-sandbox.ts#L94-L103).
- **Evidence:** The no-sandbox adapter launches both the command-string API and interactive API with `spawn(..., { shell: false })`. Sandcastle's Codex provider supplies the command string beginning with `codex exec`; an npm-installed CLI is commonly exposed as a Windows `codex.cmd` command shim. Node's child-process documentation states that `.bat` and `.cmd` files cannot be launched on Windows without a shell; callers must use a shell, `exec()`, or spawn `cmd.exe` with the script as an argument ([Node.js `child_process` documentation](https://nodejs.org/download/release/v22.19.0/docs/api/child_process.html#spawning-bat-and-cmd-files-on-windows)).
- **Failure scenario:** On a native Windows host where `codex` resolves to `codex.cmd`, every Agent Attempt reaches `spawn("codex", ..., shell:false)` and receives `ENOENT`/`EACCES`. The Runner then reports a provider failure even though `codex` is directly runnable from PowerShell as required by the README.
- **Recommendation:** Keep argv execution (to avoid shell parsing) but resolve the configured Codex executable to a native executable, or add a Windows-only launcher that invokes the `.cmd` shim through `ComSpec` with correct argv quoting. Apply the same handling to `interactiveExec`.

### High — POSIX-only command quoting corrupts Windows paths

- **Location:** [`src/adapters/no-shell-sandbox.ts`](../../src/adapters/no-shell-sandbox.ts#L12-L38), especially the unconditional backslash escape at line 21.
- **Evidence:** `commandArgs()` treats every backslash outside single quotes as an escape and removes it. On Windows, backslash is the platform path separator; Node documents that `path.sep` is `\\` on Windows and that both `\\` and `/` are accepted path separators ([Node.js `path.sep` documentation](https://nodejs.org/api/path.html#pathsep)).
- **Failure scenario:** A command emitted by the Codex agent such as `git -C C:\\work\\repo status` (or a quoted double-quoted Windows path) is converted to `C:workrepo` before `spawn()`. Git, test runners, and scripts then run against a different path or fail with `ENOENT`. The parser only implements the POSIX shell escaping used by Sandcastle's generated Codex command and has no Windows command-line grammar.
- **Recommendation:** Replace the handwritten command-string parser with an argv-bearing sandbox boundary, or make parsing platform-aware and preserve Windows path separators while handling Windows quoting rules. Add one native Windows smoke test with a path containing spaces and backslashes.

### Medium — Recovery durability assumes POSIX directory `fsync`

- **Location:** [`src/recovery.ts`](../../src/recovery.ts#L484-L489).
- **Evidence:** After renaming the temporary snapshot, `writeRecoverySnapshot()` opens the parent directory as a file and calls `FileHandle.sync()`. Node documents `filehandle.sync()` as an operating-system/device-specific flush that refers to POSIX `fsync(2)`, and separately documents platform-specific behavior when opening directories ([Node.js `filehandle.sync()`](https://nodejs.org/api/fs.html#filehandlesync), [Node.js `fsPromises.open()`](https://nodejs.org/api/fs.html#fspromisesopenpath-flags-mode)). There is no Node portability contract that a directory handle can be opened and synchronized on every supported OS; Windows has historically returned `EPERM` for `fsync` calls ([Node.js issue #3879](https://github.com/nodejs/node/issues/3879)).
- **Failure scenario:** On a Windows filesystem/Node build that rejects syncing a directory handle, the rename has already completed but `writeRecoverySnapshot()` rejects. The CLI calls this function during startup and after each state transition, so the Run can fail before discovery or after a successful state write solely because the post-rename durability step is unsupported.
- **Recommendation:** Treat parent-directory syncing as an optional platform capability: retain file `sync()` and atomic rename, but skip or downgrade a directory-sync `EPERM`/unsupported error on Windows, or provide a tested Windows-specific durability primitive. Add a native Windows recovery test before claiming crash-durable snapshots across OSes.

## Non-findings and evidence gaps

- No production code checks `process.platform`, `process.arch`, or hard-codes `/tmp`, `/bin`, `cmd.exe`, or PowerShell paths. Temporary directories use `os.tmpdir()` and configured checkout paths are required to be absolute.
- `LocalGitWorkspace` and `GitHubClient` use `execFile("git"/"gh", ..., shell:false)`. Git for Windows and GitHub CLI provide native executables, so no `.cmd` limitation was found there; this still needs a native smoke run.
- `readReviewStandards()` uses `path.posix.dirname()` only on Git output (`ls-files`), whose documented format is slash-separated and therefore intentionally independent of host path separators.
- npm scripts invoke npm, Prettier, ESLint, and TypeScript without POSIX shell operators. npm does use `/bin/sh` on POSIX and `cmd.exe` on Windows, so future script changes must avoid shell-only syntax ([npm scripts documentation](https://docs.npmjs.com/cli/v11/using-npm/scripts#description)).
- This checkout is Linux-only; the Windows findings require a native Windows run to verify exact error codes and shim resolution, but both identified paths violate the stated “any qualified Node environment” portability contract without that adaptation.
