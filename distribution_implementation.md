# Distribution implementation plan

## Goal and scope

Prepare `redwake-agent` for standalone GitHub Release distribution so that, after a separate installer is added, a user can invoke the app from any directory with:

```sh
rwa
```

The public `curl` installer and hosting/serving `install.sh` are explicitly out of scope. This work produces the release artifacts and stable GitHub Release URLs that the future installer will consume.

Use this naming and namespace contract throughout the implementation and documentation:

| Context | Canonical name | Notes |
|---|---|---|
| Master brand | **Redwake** | The umbrella brand for this app and future Redwake apps. Do not use it as this app's name or command. |
| App, package, and GitHub repository | **`redwake-agent`** | The canonical app slug. Human-facing prose may render it as **Redwake Agent**. Rename the existing `redwake-coding-agent` package/repository to this slug. |
| User command and installed executable | **`rwa`** | Stands for **redwake-agent**. Also use this prefix for target-specific binaries and release archives. |
| Shared state namespace | **`redwake/`** | A parent directory reserved for state belonging to multiple Redwake apps. It is not this app's complete state root. |
| Agent state root | **`redwake/agent/`** | This app's directory inside the shared Redwake namespace. |

Install only the `rwa` executable; do not add `redwake` or `redwake-agent` command aliases. Do not continue using the obsolete `redwake-coding-agent` name after the package and repository rename. The distinct names are intentional: Redwake is the master brand, `redwake-agent` is the app, `rwa` is its command, and `redwake/agent` is its namespaced state directory.

## 1. Establish and enforce the three filesystem roots

### 1.1 Add a root/path module

Create `source/paths.ts` as the single place that defines these concepts:

- **Install root**: code and bundled assets. Resolve from `import.meta.dir`, never from `process.cwd()`. At present, the system prompt is built in TypeScript and there are no required runtime assets, but this root must be available for future install-owned files.
- **Workspace root**: the resolved `process.cwd()` after processing the optional positional workspace argument. Preserve current behavior rather than silently changing to a Git root. Tool paths, prompt identity, and workspace session identity must all use this root.
- **State root**: `${XDG_CONFIG_HOME}/redwake/agent` when `XDG_CONFIG_HOME` is a non-empty absolute path; otherwise `${homedir()}/.config/redwake/agent`. The `redwake` parent is the shared master-brand namespace; `agent` identifies this app.

Export helpers/constants for at least:

```text
STATE_ROOT
AUTH_DB_PATH       = <state>/auth.sqlite
SESSIONS_ROOT      = <state>/sessions
INSTALLATION_ID_PATH = <state>/installation-id
```

Reject or ignore an invalid relative `XDG_CONFIG_HOME` consistently; use the documented home fallback rather than allowing state to be written relative to the workspace.

### 1.2 Replace existing state paths

Update:

- `source/config.ts`: replace the hardcoded legacy non-XDG `~/redwake/agent/sessions` and `~/redwake/agent/auth.sqlite` paths with the centralized XDG-aware paths; import/re-export them if compatibility with existing imports is useful.
- `source/codex/installation.ts`: replace its private legacy non-XDG `~/redwake/agent/installation-id` constant with `INSTALLATION_ID_PATH`.
- `source/auth/store.ts`, `source/session/store.ts`, and `source/session/navigator.ts`: consume the centralized state paths.

The current source audit found no install-owned Markdown prompt read at runtime and no relative `Bun.file(...)`/`readFileSync("./...")` call. `source/agent/system-prompt.ts` already constructs the prompt in TypeScript, so it will be bundled. Keep it that way unless a prompt asset is later introduced; any future asset must use a static text import so `bun build --compile` embeds it.

### 1.3 Make state private

Introduce a small helper in `source/paths.ts` (or a dedicated `source/state.ts`) that creates state directories with mode `0700`. Apply it to the shared `redwake` parent, the app-specific `agent` state root, auth, and session directories without assuming that this app owns the shared parent exclusively.

- Keep the auth SQLite database at mode `0600`.
- Ensure SQLite sidecar files (`-wal` and `-shm`), when present, are not group/world accessible.
- Create session JSONL files with mode `0600`; session content can contain source code and model/tool transcripts and should be treated as private.
- Keep `installation-id` at mode `0600`.
- Continue refusing an auth/state directory owned by another user where UID ownership checks are supported.

Do not store credentials, quota data, session data, or model selection in the workspace. Do not add explicit loading of credentials from a workspace `.env`. Provider API keys may continue to come from the process environment; document that standalone `rwa` does not depend on an install-root `.env`.

### 1.4 Handle legacy state

Add a conservative one-time migration from the legacy non-XDG `${homedir()}/redwake/agent` location to the XDG-aware state root defined in section 1.1. This changes the configuration base while preserving the intentional `redwake/agent` namespace:

- Run before opening the auth database or creating a new session.
- If the new state path for an item does not exist, move/copy `auth.sqlite` (including applicable SQLite sidecars), `sessions/`, and `installation-id` from the legacy root.
- Never overwrite new-state data.
- Preserve or tighten permissions after migration.
- If migration cannot complete, report an actionable warning and do not delete the legacy data.
- Make the migration idempotent and unit-test it with temporary directories. Allow path injection in tests so tests never touch a developer's home directory.

If compatibility with pre-release local data is intentionally not desired, this migration may instead be omitted only with an explicit release note; the preferred implementation is to migrate.

### 1.5 Verify workspace independence

Retain the positional workspace behavior in `source/main.ts`: `rwa /path/to/project` changes directory before creating tools and sessions. Make the resolved workspace explicit and pass it into session/tool/prompt setup where practical instead of repeatedly relying on an ambient CWD.

Add integration coverage that starts the entry point from a temporary directory outside the repository and verifies:

- the workspace shown to the prompt/UI is the temporary directory;
- relative read/write/edit/bash operations resolve in that workspace;
- no state is created in the workspace;
- state is created under an injected XDG configuration root.

## 2. Add the real `rwa` CLI entry point

### 2.1 Create `source/cli.ts`

Create an executable entry point with:

```ts
#!/usr/bin/env bun
```

It should:

1. Set `process.title` to `rwa`.
2. Handle `-h`/`--help` and `-v`/`--version` before initializing provider configuration, auth, sessions, or the TUI.
3. Dynamically import and call `main()` for a normal invocation so help/version remain fast and cannot create state.
4. Catch argument/startup errors, print a concise message to stderr, and return a nonzero exit code without a raw stack trace unless debug behavior explicitly requests one.

Use `package.json` as the single version source. Import it statically as JSON (or generate a statically imported `source/version.ts`) so the version is embedded by Bun's compiler. Output should be stable and script-friendly, for example:

```text
rwa 0.1.0
```

Help should document:

```text
Usage: rwa [workspace] [options]

Options:
  --resume <path>  Resume a session JSONL file
  --no-tui         Use line-oriented output
  --debug          Show startup internals and use plain output
  -h, --help       Show help
  -v, --version    Show version
```

Keep `source/client.ts` temporarily as a development/backward-compatible wrapper around the same CLI, or replace the `start` script with `source/cli.ts` and remove `client.ts` once all references are updated. There must be one authoritative argument-handling path.

### 2.2 Update package metadata and scripts

Update `package.json`:

```json
{
  "bin": { "rwa": "./source/cli.ts" }
}
```

Rename the package from the obsolete `redwake-coding-agent` slug to `redwake-agent`. Rename the GitHub repository from `kvxi/redwake-coding-agent` to `kvxi/redwake-agent` before publishing releases, then update repository metadata, badges, links, and developer remotes as applicable. Do not rely on GitHub's old-repository redirect as the canonical distribution URL. The `bin` key, not the package slug, defines the user command, which remains `rwa`. Update scripts to include:

- `start`: run `source/cli.ts` directly.
- `build`: compile a native development binary to `dist/rwa`.
- Target-specific build commands or a `scripts/build-release.ts` helper for the release matrix.
- Existing `test` and `typecheck` commands.

The native build command is:

```sh
bun build ./source/cli.ts --compile --minify --outfile ./dist/rwa
```

Add `dist/` to `.gitignore`.

### 2.3 CLI tests

Add tests for:

- `--help`, `-h`, `--version`, and `-v` output and exit status;
- help/version creating no state files;
- unknown flags, duplicate positional arguments, and missing `--resume` values returning nonzero;
- positional workspace and existing runtime flags passing through unchanged;
- command/help text consistently using `rwa` as the executable name, never `redwake`, `redwake-agent`, or obsolete `redwake-coding-agent`; app identification may say `redwake-agent`/Redwake Agent and master-brand prose may say Redwake.

Refactor argument parsing out of `source/main.ts` if needed so it can be tested without launching the REPL.

## 3. Produce standalone binaries

### 3.1 Define the release matrix

Build these Bun compile targets:

| Release target | Bun target | Output before packaging |
|---|---|---|
| macOS Apple Silicon | `bun-darwin-arm64` | `rwa-darwin-arm64` |
| macOS Intel | `bun-darwin-x64` | `rwa-darwin-x64` |
| Linux x64 | `bun-linux-x64` | `rwa-linux-x64` |
| Linux ARM64 | `bun-linux-arm64` | `rwa-linux-arm64` |
| Linux x64 without AVX2 | `bun-linux-x64-baseline` | `rwa-linux-x64-baseline` |

Every archive must contain one executable named exactly `rwa`, regardless of the target-specific build filename. Use deterministic asset names:

```text
rwa-darwin-arm64.tar.gz
rwa-darwin-x64.tar.gz
rwa-linux-x64.tar.gz
rwa-linux-arm64.tar.gz
rwa-linux-x64-baseline.tar.gz
SHA256SUMS
```

### 3.2 Validate compiled behavior

Before release automation, build and smoke-test the host-native `dist/rwa`:

- run `dist/rwa --version` and compare it with `package.json`;
- run `dist/rwa --help`;
- run it from a directory outside the checkout with an isolated `XDG_CONFIG_HOME`;
- verify it does not require Bun to be installed at runtime (test in a clean CI environment/path);
- inspect the archive to ensure its root executable is `rwa` and executable mode is retained;
- verify no required prompt/config asset is being loaded from the source checkout.

Do not ship `.env`, credentials, sessions, tests, or source-tree-only files in archives.

## 4. Automate tagged GitHub releases

### 4.1 Add `.github/workflows/release.yml`

Trigger on tags matching the chosen release convention, preferably `v*` (for example `v0.1.0`). Grant only the required permission:

```yaml
permissions:
  contents: write
```

Pin a Bun version in CI so builds are reproducible. The workflow should contain separate build jobs by host OS:

- **macOS job on `macos-latest`**: build `darwin-arm64` and `darwin-x64`. Do not build Mach-O outputs on Linux. Ad-hoc sign each binary with `codesign --force --sign - <binary>` before packaging, then verify with `codesign --verify`.
- **Linux job on `ubuntu-latest`**: build `linux-x64`, `linux-arm64`, and `linux-x64-baseline`.

For each target:

1. Check out the tagged commit.
2. Install the pinned Bun version and dependencies with the frozen lockfile.
3. Run `bun test` and `bun run typecheck` at least once per host (or in a required validation job).
4. Compile from `source/cli.ts` with `--compile --minify --target=...`.
5. Stage the output as a file named `rwa`, set executable mode, and create the target-named `.tar.gz`.
6. Upload the archive as a workflow artifact for the release job.

### 4.2 Assemble checksums and publish

A final Linux release job should depend on all validation/build jobs, download all five archives into one directory, generate `SHA256SUMS` with archive filenames only, and verify it locally with `sha256sum --check SHA256SUMS`.

Create or update the GitHub Release for the pushed tag and attach all archives plus `SHA256SUMS` (for example with `gh release create "$GITHUB_REF_NAME" ... --generate-notes`, handling an already-created release if reruns are supported).

This gives the future installer stable URLs such as:

```text
https://github.com/kvxi/redwake-agent/releases/latest/download/rwa-darwin-arm64.tar.gz
https://github.com/kvxi/redwake-agent/releases/latest/download/SHA256SUMS
```

Add workflow safeguards:

- fail if any of the five expected archives is missing;
- fail if duplicate/unexpected archive names are present;
- fail if the CLI version does not match the tag after stripping a leading `v`;
- do not publish a release when tests, typechecking, signing, smoke tests, or checksum verification fail.

Where cross-compiled binaries cannot execute on the build host, execute the host-native target and at minimum inspect the other outputs with `file`; native execution on each architecture can be added later with architecture-specific runners.

## 5. Documentation updates

Update `README.md` to describe distribution-ready usage while retaining contributor instructions:

- Identify the app as `redwake-agent` (or Redwake Agent in prose), under the Redwake master brand; remove the obsolete `redwake-coding-agent` name.
- Explain that the user command is `rwa` and that it stands for redwake-agent, including `rwa [workspace]`, `rwa --resume ...`, `rwa --help`, and `rwa --version`.
- Bun is a development/build requirement, not an end-user runtime requirement for release binaries.
- State location is `$XDG_CONFIG_HOME/redwake/agent/` when set, otherwise `~/.config/redwake/agent/`, with auth database, sessions, and installation ID listed. Explain that `redwake/` is shared by multiple Redwake apps and `agent/` belongs to this app.
- State is global/private and never written into the current repository.
- API keys are read from the environment. Remove or clarify stale claims that rely on running Bun from the repository and automatically using a repository-root `.env`.
- Remove or correct the stale `source/custom_system.md` reference because that file does not currently exist; describe the current TypeScript-built system prompt or add a bundled customization mechanism separately.
- Keep a contributor section for `bun install`, `bun run start`, tests, typechecking, and native builds.
- State that the curl installer will be supplied separately and is not part of this change.

## 6. Final verification checklist

Run the following before considering implementation complete:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
./dist/rwa --help
./dist/rwa --version
```

Then perform an isolated smoke test from outside the source tree with temporary HOME/XDG state and a non-secret provider configuration. Confirm:
 
- [ ] The package and renamed GitHub repository use `redwake-agent`; `redwake-coding-agent` remains only in migration/rename notes, not active metadata or URLs.
- [ ] `rwa` is the only installed executable name required by users and is documented as standing for redwake-agent.
- [ ] `--help` and `--version` succeed without starting the REPL or creating state.
- [ ] The standalone executable runs without a system Bun installation.
- [ ] Relative tools operate on the invocation workspace, not the install/build directory.
- [ ] Auth, quota/model cache, sessions, and installation ID live only under the app state root at `<config>/redwake/agent`, preserving `redwake` as the shared multi-app parent.
- [ ] State directories are `0700` and secret/private files are `0600`.
- [ ] Legacy state migration is safe, idempotent, and non-destructive.
- [ ] A test tag produces all five correctly named archives plus a valid `SHA256SUMS`.
- [ ] Each archive contains an executable named `rwa`.
- [ ] macOS binaries are built on macOS and pass ad-hoc signature verification.
- [ ] `releases/latest/download/<asset>` resolves after publication.
- [ ] No installer script or installer hosting is included in this scope.
