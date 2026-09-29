# AgentBox: OpenCode V2 host parity

Date: 2026-09-29

## Goal and approved decisions

Make `agentbox --tool opencode` reproduce the user's existing OpenCode V2 setup inside an ephemeral container. Preserve host preferences, authentication, session history, plugins, skills, MCP configuration, and Herdr integration.

The user approved:
- Full host parity, not just a stock OpenCode installation.
- Host networking, rather than a Meridian-only relay.
- Selective filesystem mounts, not the entire host home directory.
- Shared OpenCode configuration, authentication, and session history, with separate container service state.
- Removal of `ocv`; OpenCode V2 replaces it. Claude support remains unchanged.

## Current system and compatibility gaps

AgentBox has three core files: `Dockerfile`, `agentbox`, and `entrypoint.sh`. OpenCode is selectable but is no longer installed in the image. Its current mounts share only the global config and data directories. `ocv` is installed and selectable.

The inspected host runs OpenCode **2.0.19** and has:
- A global config directory symlinked into its configurations repository, with another absolute symlink for `opencode.json`.
- Mixed supported legacy and native V2 settings; these must not be converted or rewritten by AgentBox.
- Meridian's V2 plugin at `/usr/lib/meridian/dist/meridian-v2`, and an Anthropic endpoint on host loopback port **3456**.
- Meridian settings and a local scrub plugin under its own config directory; its settings file is also symlinked.
- Superpowers and safety-net package plugins, local Jev/routing plugins, agents, commands, and skills.
- CLI-only Herdr and provider-indicator plugins in `cli.json`.
- A Herdr Unix socket and launch-context environment variables.
- Remote InterBase MCP servers whose authorization uses a file reference outside the current project.
- Four disabled debugger MCP servers using scripts under the current repository's `Tools/` directory.
- Shared SQLite session data and auth under the OpenCode data directory; runtime/service state is stored separately.

Docker is available for real build and startup verification. No host configuration or credential contents have been changed during discovery.

## Approach

Use the existing bind-mount architecture, extended with dependency discovery and OpenCode-specific runtime handling. Copying the configuration would introduce drift; mounting the whole home directory would unnecessarily expand filesystem access. Neither alternative is selected.

### Installation and version compatibility

Install the official V2 npm package, **`@opencode/cli`**, using the existing NVM/Node installation. Do not install the V1 package or `ocv`. Verify the installed executable and version during the image build.

When a host OpenCode V2 executable is available, use its version for the image installation. Include that selection in image compatibility/rebuild checks, so an existing image cannot silently run a different release against the shared database. Without a host V2 installation, use the official package's current stable V2 release. For OpenCode-selected launches, reject a detected V1 host version with a clear explanation rather than sharing its data with an implicitly selected V2 release; do not block Claude launches.

No Meridian server is installed or started in the container. Use the existing host service; mount its installed plugin package and dependencies read-only at their configured absolute locations. Node/package requirements needed by configured plugins must be covered by the image and verified during startup tests; do not add Bun solely because OpenCode V1 used it.

### Filesystem dependencies and persistence

Keep the existing writable OpenCode config and data mounts. Also expose their host-path aliases and canonical symlink destinations where required, so absolute references remain valid without rewriting host files.

Mount only dependencies needed by the configured setup:
- OpenCode config content, including local plugins, CLI plugins, agent/command definitions, and their adjacent dependencies.
- Meridian's installed package, its config directory, and external symlink targets. Its catalog cache must remain writable; installed code and standalone external settings targets are read-only.
- Global skill directories supported by V2, including `~/.claude/skills` and `~/.agents/skills` when present. Do not expose unrelated Claude credentials merely to make skills available.
- External files explicitly referenced by configuration, including `{file:...}` MCP credential references. Mount credential files read-only at their original paths, not their enclosing repositories.
- External local plugin paths and symlink targets required by these sources. Follow OpenCode's per-setting resolution rules: relative plugins resolve against their defining config file, while explicit relative skill sources resolve against the working directory. Deduplicate mounts and terminate on symlink cycles.

Read JSON/JSONC as data; never source or evaluate it. Discovery must work with the current supported V1/V2 config shapes and CLI configuration. Use image-provided tooling for structured parsing rather than introducing a new host Python/Node requirement. Do not recursively mount arbitrary home directories or infer access to projects beyond configured dependencies and existing `--add-dir`/`--parent` behavior.

Store OpenCode's container cache under AgentBox-managed persistent storage, separate from the host cache. Use container-local runtime/service state rather than mounting host state or sharing its service registration. Shared data retains host authentication and session history; runtime isolation does not make that data private from the container.

### Networking, service ownership, and launch context

Use `--network=host` for OpenCode-selected launches, including its selected shell mode. Keep other tools' networking unchanged. With host networking, `-p` publication has no effect: warn and omit conflicting publication options for OpenCode instead of implying they still provide isolation or remapping.

Launch managed OpenCode with a private server (`--standalone`) and container-local state. Do not forward host OpenCode session IDs, service endpoints, registration, or generic execution environment wholesale. An explicitly supplied remote-server selection conflicts with the managed private-server policy and must produce an actionable error rather than silently execute tools outside the container.

When launched inside Herdr, mount the configured Unix socket and forward the launch identity/context allowlist: `HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, and `HERDR_WORKSPACE_ID`, when set. Preserve the configured socket path. Handle symlinked ancestors without mounting the surrounding Herdr configuration directory. Missing Herdr context outside Herdr is normal; an advertised but unavailable socket produces a warning. Socket access permits Herdr RPC; a read-only bind does not restrict the socket's protocol.

MCP definitions, enabled/disabled status, model routing, permissions, CLI settings, and provider URLs remain unchanged. The disabled debugger servers stay disabled; this update does not install Wine or Windows debugger dependencies for them.

### Removal of ocv

Remove its installation, tool validation/selection, launch command, startup banner branch, and current user-facing documentation. Reject `--tool ocv` with the normal invalid-tool error, listing only supported tools. Preserve historical specs/plans and unrelated user files.

## Failure handling and safety

Missing required local plugin code or explicit credential-file dependencies must be reported by path without printing file contents, authorization headers, or environment-secret values. Missing optional skill roots and absent Herdr context are not fatal.

Do not edit the host database, service registration, plugin sources, or config files to repair startup. Normal OpenCode operation may write to the approved shared config/data mounts and Meridian catalog cache. Do not disable or restart host services as part of container launch.

Host networking intentionally removes network isolation and permits access to host-local services beyond Meridian. Selective mounts preserve a limited filesystem view, but this is not a Meridian-only network sandbox. Document that tradeoff and the writable shared-data boundary concisely.

## Changes and tests

- **Dockerfile:** official V2 installation/version selection; remove ocv.
- **agentbox:** version-aware rebuild compatibility, selective dependency mounts, networking, launch-context handling, private-server launch, and supported-tool/help updates.
- **entrypoint.sh:** required aliases/runtime setup and banner changes without changing Claude behavior.
- **opencode-dependencies.cjs:** focused read-only configuration discovery using Node and a JSONC parser installed in the image. Include this helper in rebuild hashing. Run discovery with minimal read-only config mounts and no loaded OpenCode plugins; its structured output contains paths and mount modes, never credential values.
- **README.md / DEVELOPMENT_NOTES.md:** concise current behavior and security-boundary documentation.
- **Tests:** add fixtures and regression coverage without depending on live credentials.

Automated tests must cover version parsing/rebuild selection; removal of ocv; preservation of Claude behavior; ordinary and symlinked config roots; absolute and relative plugin paths; JSONC and legacy/native MCP forms; read-only external credential mounts; duplicate/cyclic symlinks; optional missing paths; Herdr socket/context propagation; host-network versus bridge behavior; port-publication warnings; isolated runtime state; private-server argument handling; and shell/argument passthrough.

Build the actual image and verify the selected OpenCode version, dependency readability, plugin/agent/skill catalogs, CLI plugin loading, Herdr socket access, Meridian loopback reachability, and enabled MCP connectivity. Use read-only API/catalog/health operations where possible. Do not submit prompts, make paid model requests, resume/interrupt host sessions, enable disabled MCP servers, or mutate host configuration as test setup. Use fixture data for destructive or migration tests.

Startup or connectivity failures must be reported as unverified or blocked rather than treated as successful parity. Full parity is complete only when the actual configured integrations have been exercised; basic `--version` output is insufficient.

## Out of scope

Changing the default tool from Claude, converting host config to native V2 syntax, porting host plugins, changing model/provider choices or permissions, starting/managing Meridian or Herdr, installing disabled debugger runtimes, introducing a new sandbox framework, or deleting historical ocv documentation.

## Sources

- OpenCode V2 installation: https://opencode.ai/v2/docs/
- Migration/compatibility: https://opencode.ai/v2/docs/migrate-v1
- Config/plugin resolution: https://opencode.ai/v2/docs/config and https://opencode.ai/v2/docs/plugins
- Private-server CLI and paths: https://opencode.ai/v2/docs/cli
- CLI config/plugins: https://opencode.ai/v2/docs/cli/config and https://opencode.ai/v2/docs/cli/plugins
- Skill discovery: https://opencode.ai/v2/docs/skills
- Read-only inspection of AgentBox and the current host setup; `@opencode/cli@2.0.19` npm metadata confirms the selected official package exists.
